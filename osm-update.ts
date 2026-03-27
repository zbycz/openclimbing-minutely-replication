import { XMLParser } from "fast-xml-parser"
import { gunzipSync } from "node:zlib"

const OVERPASS_FILE = "overpass.json"
const OUTPUT_FILE = "overpass-updated.json"
const REPLICATION_BASE = "https://planet.openstreetmap.org/replication/minute"
const OSM_API = "https://api.openstreetmap.org/api/0.6"
const REQUEST_LIMIT = 100
const RATE_LIMIT_MS = 1000
const BATCH_SIZE = 100

let requestCount = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const isClimbing = (tags) => {
  if (!tags) return false
  return (
    Object.keys(tags).some((k) => k.startsWith("climbing")) ||
    tags.sport === "climbing" ||
    tags.sport === "via_ferrata"
  )
}

const seqToPath = (seq) => {
  const s = String(seq).padStart(9, "0")
  return `${s.slice(0, 3)}/${s.slice(3, 6)}/${s.slice(6, 9)}`
}

const fetchWithRateLimit = async (url) => {
  if (requestCount >= REQUEST_LIMIT) throw new Error(`Request limit ${REQUEST_LIMIT} reached`)
  await sleep(RATE_LIMIT_MS)
  requestCount++
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res
}

const fetchState = async (url) => {
  const res = await fetchWithRateLimit(url)
  const text = await res.text()
  const seqMatch = text.match(/sequenceNumber=(\d+)/)
  const tsMatch = text.match(/timestamp=(.+)/)
  if (!seqMatch || !tsMatch) throw new Error(`Bad state file: ${text}`)
  return {
    seq: parseInt(seqMatch[1]),
    timestamp: new Date(tsMatch[1].replace(/\\:/g, ":")),
  }
}

const findStartSeq = async (baseTimestamp, currentSeq, currentTs) => {
  const target = new Date(baseTimestamp)
  let lo = Math.max(1, currentSeq - Math.ceil((currentTs - target) / 60000) - 10)
  let hi = currentSeq

  while (lo < hi) {
    if (requestCount >= REQUEST_LIMIT) break
    const mid = Math.floor((lo + hi) / 2)
    const state = await fetchState(`${REPLICATION_BASE}/${seqToPath(mid)}.state.txt`)
    if (state.timestamp <= target) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }

  return lo - 1
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["node", "way", "relation", "nd", "tag", "member"].includes(name),
})

const parseOsmChangeElement = (raw, action) => {
  const tags = {}
  for (const t of raw.tag || []) tags[t["@_k"]] = t["@_v"]
  const base = { id: parseInt(raw["@_id"]), action }
  if (raw["@_lat"] !== undefined) {
    base.type = "node"
    base.lat = parseFloat(raw["@_lat"])
    base.lon = parseFloat(raw["@_lon"])
  } else if (raw.nd !== undefined) {
    base.type = "way"
    base.nodes = raw.nd.map((n) => parseInt(n["@_ref"]))
  } else {
    base.type = "relation"
    base.members = (raw.member || []).map((m) => ({
      type: m["@_type"],
      ref: parseInt(m["@_ref"]),
      role: m["@_role"] || "",
    }))
  }
  if (Object.keys(tags).length > 0) base.tags = tags
  return base
}

const fetchDiff = async (seq) => {
  const res = await fetchWithRateLimit(`${REPLICATION_BASE}/${seqToPath(seq)}.osc.gz`)
  const buf = await res.arrayBuffer()
  const xml = gunzipSync(Buffer.from(buf)).toString("utf8")
  const parsed = xmlParser.parse(xml)
  const change = parsed.osmChange || {}
  const elements = []
  for (const action of ["create", "modify", "delete"]) {
    const block = change[action]
    if (!block) continue
    const blocks = Array.isArray(block) ? block : [block]
    for (const b of blocks) {
      for (const type of ["node", "way", "relation"]) {
        for (const raw of b[type] || []) {
          elements.push(parseOsmChangeElement(raw, action))
        }
      }
    }
  }
  return elements
}

const toOverpassElement = (e) => {
  const out = { type: e.type, id: e.id }
  if (e.type === "node") {
    out.lat = e.lat
    out.lon = e.lon
  } else if (e.type === "way") {
    out.nodes = e.nodes
  } else {
    out.members = e.members
  }
  if (e.tags && Object.keys(e.tags).length > 0) out.tags = e.tags
  return out
}

const fetchMissingElements = async (missingByType, elementMap) => {
  for (const [type, ids] of Object.entries(missingByType)) {
    const plural = type + "s"
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      if (requestCount >= REQUEST_LIMIT) return
      const batch = ids.slice(i, i + BATCH_SIZE)
      let data
      try {
        const res = await fetchWithRateLimit(
          `${OSM_API}/${plural}.json?${plural}=${batch.join(",")}`
        )
        data = await res.json()
      } catch {
        continue
      }
      for (const e of data.elements || []) {
        if (e.visible === false) continue
        elementMap.set(`${e.type}/${e.id}`, toOverpassElement(e))
      }
    }
  }
}

const main = async () => {
  const raw = JSON.parse(await Bun.file(OVERPASS_FILE).text())
  const baseTimestamp = raw.osm3s.timestamp_osm_base

  const elementMap = new Map()
  for (const e of raw.elements) elementMap.set(`${e.type}/${e.id}`, e)

  const currentState = await fetchState(`${REPLICATION_BASE}/state.txt`)
  const currentSeq = currentState.seq
  const startSeq = await findStartSeq(baseTimestamp, currentSeq, currentState.timestamp)

  let lastProcessedSeq = startSeq

  for (let seq = startSeq + 1; seq <= currentSeq; seq++) {
    if (requestCount >= REQUEST_LIMIT) {
      console.log(`Request limit reached at seq ${seq}`)
      break
    }
    const elements = await fetchDiff(seq)
    for (const e of elements) {
      const key = `${e.type}/${e.id}`
      if (e.action === "delete") {
        elementMap.delete(key)
      } else {
        if (isClimbing(e.tags) || elementMap.has(key)) {
          elementMap.set(key, toOverpassElement(e))
        }
      }
    }
    lastProcessedSeq = seq
  }

  let lastTimestamp = baseTimestamp
  if (lastProcessedSeq > startSeq && requestCount < REQUEST_LIMIT) {
    const finalState = await fetchState(`${REPLICATION_BASE}/${seqToPath(lastProcessedSeq)}.state.txt`)
    lastTimestamp = finalState.timestamp.toISOString()
  }

  const missingByType = { node: [], way: [], relation: [] }
  for (const e of elementMap.values()) {
    if (e.type === "way") {
      for (const nid of e.nodes || []) {
        if (!elementMap.has(`node/${nid}`)) missingByType.node.push(nid)
      }
    } else if (e.type === "relation") {
      for (const m of e.members || []) {
        if (!elementMap.has(`${m.type}/${m.ref}`)) missingByType[m.type].push(m.ref)
      }
    }
  }

  for (const k of Object.keys(missingByType)) {
    missingByType[k] = [...new Set(missingByType[k])]
  }

  await fetchMissingElements(missingByType, elementMap)

  const output = {
    osm3s: { timestamp_osm_base: lastTimestamp },
    elements: [...elementMap.values()],
  }

  await Bun.write(OUTPUT_FILE, JSON.stringify(output, null, 0))
  console.log(`Done. ${elementMap.size} elements, ${requestCount} requests. Written to ${OUTPUT_FILE}`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
