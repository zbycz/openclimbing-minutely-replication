#!/usr/bin/env bun
/**
 * OSM Climbing Dataset Updater
 *
 * Downloads replication diffs from planet.openstreetmap.org and applies them
 * to a filtered PBF dataset (climbing + dependency closure).
 * Missing referenced elements are fetched from the live OSM API using multi-get.
 *
 * Usage: bun run osm-update.ts input.pbf [output.pbf]
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import { XMLParser } from "fast-xml-parser";

// ─── Configuration ────────────────────────────────────────────────────────────

const PBF_FILE   = process.argv[2];
const OUTPUT_PBF = process.argv[3] ?? PBF_FILE.replace(/\.pbf$/, ".updated.pbf");
const STATE_FILE = PBF_FILE + ".state";

const OSM_API   = "https://api.openstreetmap.org/api/0.6";

// Replication levels — day diffs are ~1 GB decompressed; we top out at hour
const REPLICATIONS_MINUTE_URL      = "https://planet.openstreetmap.org/replication/minute";
const REPLICATIONS_HOUR_URL        = "https://planet.openstreetmap.org/replication/hour";
const MINUTE_THRESHOLD = 120; // use hour replication when > 2 h of diffs pending

const MAX_API_REQUESTS = 100;  // abort dependency fetch after this many OSM API calls
const API_RATE_LIMIT_MS = 1200; // ≥ 1 s between calls (OSM API policy)
const BATCH_SIZE = 100;         // element IDs per multi-get request

// ─── Types ────────────────────────────────────────────────────────────────────

interface OsmNode {
  type: "node";
  id: number; version: number; timestamp: string;
  uid: number; user: string; changeset: number;
  lat: number; lon: number;
  tags: Record<string, string>;
}

interface OsmWay {
  type: "way";
  id: number; version: number; timestamp: string;
  uid: number; user: string; changeset: number;
  nodes: number[];
  tags: Record<string, string>;
}

interface OsmRelation {
  type: "relation";
  id: number; version: number; timestamp: string;
  uid: number; user: string; changeset: number;
  members: { type: "node" | "way" | "relation"; ref: number; role: string }[];
  tags: Record<string, string>;
}

type OsmElement = OsmNode | OsmWay | OsmRelation;

interface Dataset {
  nodes: Map<number, OsmNode>;
  ways:  Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
}

interface ReplicationState {
  sequenceNumber: number;
  timestamp: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Parse a planet.openstreetmap.org state.txt file */
function parseState(text: string): ReplicationState {
  const get = (prefix: string) =>
    text.split("\n").find(l => l.startsWith(prefix))?.slice(prefix.length) ?? "";
  return {
    sequenceNumber: parseInt(get("sequenceNumber=")),
    timestamp: get("timestamp=").replace(/\\\:/g, ":"),
  };
}

/** Convert sequence number → directory path component (e.g. 7044482 → 007/044/482) */
function seqToPath(seq: number): string {
  const s = seq.toString().padStart(9, "0");
  return `${s.slice(0, 3)}/${s.slice(3, 6)}/${s.slice(6, 9)}`;
}

/** Fetch with automatic redirect following and simple retry */
async function fetchRetry(url: string, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "osm-climbing-updater/1.0 (bun)" },
        redirect: "follow",
      });
      if (res.ok) return res;
      if (res.status === 404) throw new Error(`HTTP 404: ${url}`);
      lastErr = new Error(`HTTP ${res.status}: ${url}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < retries - 1) await sleep(1500 * (i + 1));
  }
  throw lastErr;
}

/** Escape characters that are special in XML attribute values */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Climbing filter ──────────────────────────────────────────────────────────

/**
 * Returns true if the element is a "climbing" element that belongs
 * in this filtered dataset (regardless of whether it's already present).
 */
function isClimbing(tags: Record<string, string>): boolean {
  if (!tags || Object.keys(tags).length === 0) return false;
  return (
    tags["sport"] === "climbing" ||
    tags["sport"] === "via_ferrata" ||
    tags["leisure"] === "climbing" ||
    "climbing" in tags ||
    Object.keys(tags).some(k => k.startsWith("climbing:"))
  );
}

// ─── Shared XMLParser config ───────────────────────────────────────────────────

const ARRAY_TAGS = new Set(["node", "way", "relation", "tag", "nd", "member", "create", "modify", "delete"]);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => ARRAY_TAGS.has(name),
  processEntities: false,   // OSM XML doesn't use XML entities; avoids the 1000-entity default cap
});

// ─── Parsing helpers ───────────────────────────────────────────────────────────

function parseTags(tagArr: any[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const t of tagArr ?? []) tags[t["@k"]] = t["@v"];
  return tags;
}

function parseNode(n: any): OsmNode {
  return {
    type: "node",
    id: +n["@id"], version: +n["@version"], timestamp: n["@timestamp"],
    uid: +(n["@uid"] ?? 0), user: n["@user"] ?? "", changeset: +(n["@changeset"] ?? 0),
    lat: +n["@lat"], lon: +n["@lon"],
    tags: parseTags(n.tag),
  };
}

function parseWay(w: any): OsmWay {
  return {
    type: "way",
    id: +w["@id"], version: +w["@version"], timestamp: w["@timestamp"],
    uid: +(w["@uid"] ?? 0), user: w["@user"] ?? "", changeset: +(w["@changeset"] ?? 0),
    nodes: (w.nd ?? []).map((nd: any) => +nd["@ref"]),
    tags: parseTags(w.tag),
  };
}

function parseRelation(r: any): OsmRelation {
  return {
    type: "relation",
    id: +r["@id"], version: +r["@version"], timestamp: r["@timestamp"],
    uid: +(r["@uid"] ?? 0), user: r["@user"] ?? "", changeset: +(r["@changeset"] ?? 0),
    members: (r.member ?? []).map((m: any) => ({
      type: m["@type"] as "node" | "way" | "relation",
      ref: +m["@ref"],
      role: m["@role"] ?? "",
    })),
    tags: parseTags(r.tag),
  };
}

function parseElements(section: any): OsmElement[] {
  const out: OsmElement[] = [];
  for (const n of section.node     ?? []) out.push(parseNode(n));
  for (const w of section.way      ?? []) out.push(parseWay(w));
  for (const r of section.relation ?? []) out.push(parseRelation(r));
  return out;
}

// ─── PBF / OSM XML reading ────────────────────────────────────────────────────

function parseOsmXml(xml: string): Dataset {
  const parsed = xmlParser.parse(xml);
  const osm = parsed.osm ?? {};
  const dataset: Dataset = {
    nodes: new Map(), ways: new Map(), relations: new Map(),
  };
  for (const n of osm.node     ?? []) { const el = parseNode(n);     dataset.nodes.set(el.id, el); }
  for (const w of osm.way      ?? []) { const el = parseWay(w);      dataset.ways.set(el.id, el); }
  for (const r of osm.relation ?? []) { const el = parseRelation(r); dataset.relations.set(el.id, el); }
  return dataset;
}

// ─── OSC diff: streaming SAX application ─────────────────────────────────────
// Hour diffs decompress to ~35 MB; we stream-parse with SAX so the full XML
// DOM is never in memory — only the element being parsed.

import sax from "sax";

/**
 * Parse a decompressed OSC XML buffer with a streaming SAX parser and apply
 * each change directly to `dataset`.  Peak extra memory ≈ size of one element.
 */
function applyOscBuffer(buf: Buffer, dataset: Dataset): void {
  const parser = sax.parser(true /* strict */);

  // Current action context: "create" | "modify" | "delete"
  let action: "create" | "modify" | "delete" | null = null;

  // Element being built
  let curNode:     Partial<OsmNode>     | null = null;
  let curWay:      Partial<OsmWay>      | null = null;
  let curRelation: Partial<OsmRelation> | null = null;

  const attr = (attrs: Record<string, string>, k: string, fallback = "") =>
    attrs[k] ?? fallback;
  const numAttr = (attrs: Record<string, string>, k: string) =>
    parseFloat(attrs[k] ?? "0");

  parser.onopentag = ({ name, attributes: _a }) => {
    const a = _a as Record<string, string>;
    if (name === "create" || name === "modify" || name === "delete") {
      action = name as typeof action;
      return;
    }
    if (!action) return;

    if (name === "node") {
      curNode = {
        type: "node",
        id: +a.id, version: +a.version, timestamp: a.timestamp,
        uid: +(a.uid ?? 0), user: a.user ?? "", changeset: +(a.changeset ?? 0),
        lat: numAttr(a, "lat"), lon: numAttr(a, "lon"),
        tags: {},
      };
    } else if (name === "way") {
      curWay = {
        type: "way",
        id: +a.id, version: +a.version, timestamp: a.timestamp,
        uid: +(a.uid ?? 0), user: a.user ?? "", changeset: +(a.changeset ?? 0),
        nodes: [], tags: {},
      };
    } else if (name === "relation") {
      curRelation = {
        type: "relation",
        id: +a.id, version: +a.version, timestamp: a.timestamp,
        uid: +(a.uid ?? 0), user: a.user ?? "", changeset: +(a.changeset ?? 0),
        members: [], tags: {},
      };
    } else if (name === "tag") {
      const el = curNode ?? curWay ?? curRelation;
      if (el?.tags) el.tags[a.k] = a.v;
    } else if (name === "nd" && curWay?.nodes) {
      curWay.nodes.push(+a.ref);
    } else if (name === "member" && curRelation?.members) {
      curRelation.members.push({
        type: a.type as "node" | "way" | "relation",
        ref: +a.ref,
        role: a.role ?? "",
      });
    }
  };

  parser.onclosetag = (name) => {
    if (name === "create" || name === "modify" || name === "delete") {
      action = null;
      return;
    }

    const commit = (el: OsmNode | OsmWay | OsmRelation) => {
      if (action === "delete") {
        if      (el.type === "node")     dataset.nodes.delete(el.id);
        else if (el.type === "way")      dataset.ways.delete(el.id);
        else if (el.type === "relation") dataset.relations.delete(el.id);
        return;
      }
      // create / modify: keep if already in dataset OR newly climbing
      const inDataset =
        (el.type === "node"     && dataset.nodes.has(el.id))     ||
        (el.type === "way"      && dataset.ways.has(el.id))      ||
        (el.type === "relation" && dataset.relations.has(el.id));

      if (inDataset || isClimbing(el.tags)) {
        if      (el.type === "node")     dataset.nodes.set(el.id,     el as OsmNode);
        else if (el.type === "way")      dataset.ways.set(el.id,      el as OsmWay);
        else if (el.type === "relation") dataset.relations.set(el.id, el as OsmRelation);
      }
    };

    if (name === "node"     && curNode)     { commit(curNode     as OsmNode);     curNode     = null; }
    if (name === "way"      && curWay)      { commit(curWay      as OsmWay);      curWay      = null; }
    if (name === "relation" && curRelation) { commit(curRelation as OsmRelation); curRelation = null; }
  };

  parser.onerror = (e) => { throw e; };

  // Feed in chunks to avoid one giant string allocation
  const CHUNK = 256 * 1024;
  for (let off = 0; off < buf.length; off += CHUNK)
    parser.write(buf.subarray(off, off + CHUNK).toString("utf-8"));
  parser.close();
}

// ─── Dependency checking ──────────────────────────────────────────────────────

interface MissingRefs {
  nodes:     Set<number>;
  ways:      Set<number>;
  relations: Set<number>;
}

function getMissingRefs(dataset: Dataset): MissingRefs {
  const nodes     = new Set<number>();
  const ways      = new Set<number>();
  const relations = new Set<number>();

  for (const way of dataset.ways.values())
    for (const id of way.nodes)
      if (!dataset.nodes.has(id)) nodes.add(id);

  for (const rel of dataset.relations.values())
    for (const m of rel.members) {
      if      (m.type === "node"     && !dataset.nodes.has(m.ref))     nodes.add(m.ref);
      else if (m.type === "way"      && !dataset.ways.has(m.ref))      ways.add(m.ref);
      else if (m.type === "relation" && !dataset.relations.has(m.ref)) relations.add(m.ref);
    }

  return { nodes, ways, relations };
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
  private lastCall = 0;
  private _count   = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxRequests: number,
  ) {}

  get count() { return this._count; }

  async throttle(): Promise<void> {
    if (this._count >= this.maxRequests)
      throw new Error(`Reached maximum of ${this.maxRequests} OSM API requests – stopping dependency fetch`);
    const elapsed = Date.now() - this.lastCall;
    if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed);
    this.lastCall = Date.now();
    this._count++;
  }
}

// ─── OSM API multi-get ────────────────────────────────────────────────────────

async function fetchOsmElements(
  type: "nodes" | "ways" | "relations",
  ids: number[],
  limiter: RateLimiter,
): Promise<OsmElement[]> {
  if (ids.length === 0) return [];
  const results: OsmElement[] = [];

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    await limiter.throttle();

    const url = `${OSM_API}/${type}.json?${type}=${batch.join(",")}`;
    console.log(`  [API ${limiter.count}/${MAX_API_REQUESTS}] GET ${type} (${batch.length} ids)`);

    const res  = await fetchRetry(url);
    const data = await res.json() as { elements?: any[] };

    for (const el of data.elements ?? []) {
      // JSON API uses plain field names (id, lat, lon…), not the @-prefixed XML attrs
      if (el.type === "node") {
        results.push({
          type: "node",
          id: el.id, version: el.version, timestamp: el.timestamp ?? "",
          uid: el.uid ?? 0, user: el.user ?? "", changeset: el.changeset ?? 0,
          lat: el.lat, lon: el.lon, tags: el.tags ?? {},
        } satisfies OsmNode);
      } else if (el.type === "way") {
        results.push({
          type: "way",
          id: el.id, version: el.version, timestamp: el.timestamp ?? "",
          uid: el.uid ?? 0, user: el.user ?? "", changeset: el.changeset ?? 0,
          nodes: el.nodes ?? [], tags: el.tags ?? {},
        } satisfies OsmWay);
      } else if (el.type === "relation") {
        results.push({
          type: "relation",
          id: el.id, version: el.version, timestamp: el.timestamp ?? "",
          uid: el.uid ?? 0, user: el.user ?? "", changeset: el.changeset ?? 0,
          members: (el.members ?? []).map((m: any) => ({
            type: m.type as "node" | "way" | "relation",
            ref: m.ref, role: m.role ?? "",
          })),
          tags: el.tags ?? {},
        } satisfies OsmRelation);
      }
    }
  }
  return results;
}

// ─── Replication sequence finder ─────────────────────────────────────────────

/**
 * Binary-search a replication archive to find the first sequence number
 * whose timestamp is ≥ targetTimestamp.
 */
async function findSequenceForTimestamp(
  replBase: string,
  targetTs: string,
  currentSeq: number,
  lookback: number,   // max sequences to look back
): Promise<number> {
  const target = new Date(targetTs).getTime();
  let lo = Math.max(1, currentSeq - lookback);
  let hi = currentSeq;

  console.log(`  Binary-searching ${replBase.split("/").pop()} sequences ${lo}..${hi}`);

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const url  = `${replBase}/${seqToPath(mid)}.state.txt`;
      const text = await (await fetchRetry(url)).text();
      const ts   = new Date(parseState(text).timestamp).getTime();
      if (ts < target) lo = mid + 1;
      else             hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

// ─── OSM XML writer ───────────────────────────────────────────────────────────

function writeOsmXml(dataset: Dataset, replicationTs: string): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<osm version="0.6" generator="osm-climbing-updater">`,
    `  <bounds minlat="-90" minlon="-180" maxlat="90" maxlon="180"/>`,
  ];

  const nodeAttrs = (n: OsmNode) =>
    `id="${n.id}" version="${n.version}" timestamp="${n.timestamp}" uid="${n.uid}" ` +
    `user="${escapeXml(n.user)}" changeset="${n.changeset}" lat="${n.lat}" lon="${n.lon}"`;

  const baseAttrs = (el: OsmWay | OsmRelation) =>
    `id="${el.id}" version="${el.version}" timestamp="${el.timestamp}" uid="${el.uid}" ` +
    `user="${escapeXml(el.user)}" changeset="${el.changeset}"`;

  const tagLines = (tags: Record<string, string>, indent: string) =>
    Object.entries(tags).map(([k, v]) =>
      `${indent}<tag k="${escapeXml(k)}" v="${escapeXml(v)}"/>`);

  for (const n of [...dataset.nodes.values()].filter(n => Number.isFinite(n.id)).sort((a, b) => a.id - b.id)) {
    const tags = tagLines(n.tags, "    ");
    if (tags.length === 0) {
      lines.push(`  <node ${nodeAttrs(n)}/>`);
    } else {
      lines.push(`  <node ${nodeAttrs(n)}>`);
      lines.push(...tags);
      lines.push(`  </node>`);
    }
  }

  for (const w of [...dataset.ways.values()].filter(w => Number.isFinite(w.id)).sort((a, b) => a.id - b.id)) {
    lines.push(`  <way ${baseAttrs(w)}>`);
    for (const ref of w.nodes) lines.push(`    <nd ref="${ref}"/>`);
    lines.push(...tagLines(w.tags, "    "));
    lines.push(`  </way>`);
  }

  for (const r of [...dataset.relations.values()].filter(r => Number.isFinite(r.id)).sort((a, b) => a.id - b.id)) {
    lines.push(`  <relation ${baseAttrs(r)}>`);
    for (const m of r.members)
      lines.push(`    <member type="${m.type}" ref="${m.ref}" role="${escapeXml(m.role)}"/>`);
    lines.push(...tagLines(r.tags, "    "));
    lines.push(`  </relation>`);
  }

  lines.push("</osm>");
  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  OSM Climbing Dataset Updater             ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log(`Input:  ${PBF_FILE}`);
  console.log(`Output: ${OUTPUT_PBF}`);
  console.log(`State:  ${STATE_FILE}\n`);

  // ── Step 1: Read current PBF ─────────────────────────────────────────────────
  console.log("── Step 1: Reading PBF ──────────────────────────────────────────");
  const tempOsm = "/tmp/osm-updater-current.osm";
  execSync(`osmium cat "${PBF_FILE}" -o "${tempOsm}" --overwrite`, { stdio: "pipe" });
  const dataset = parseOsmXml(readFileSync(tempOsm, "utf-8"));
  console.log(`  Loaded: ${dataset.nodes.size} nodes, ${dataset.ways.size} ways, ${dataset.relations.size} relations`);

  // ── Step 2: Choose replication level and find sequences ──────────────────────
  console.log("\n── Step 2: Replication state ────────────────────────────────────");

  // Extract PBF timestamp
  const pbfInfo = execSync(`osmium fileinfo "${PBF_FILE}"`, { encoding: "utf-8" });
  const tsMatch = pbfInfo.match(/osmosis_replication_timestamp=(\S+)/);
  const pbfTs   = tsMatch ? tsMatch[1] : "";
  if (!pbfTs) throw new Error("Could not read osmosis_replication_timestamp from PBF header");

  // Choose granularity based on how stale the data is
  const ageMins = (Date.now() - new Date(pbfTs).getTime()) / 60_000;
  let replicationUrl: string;
  let levelName: string;
  let lookback: number;

  if (ageMins <= MINUTE_THRESHOLD) {
    replicationUrl = REPLICATIONS_MINUTE_URL; levelName = "minute"; lookback = 43_200;
  } else {
    replicationUrl = REPLICATIONS_HOUR_URL;   levelName = "hour";   lookback = 8_760;
  }

  // Fetch current remote state for the chosen level
  const remoteState = parseState(await (await fetchRetry(`${replicationUrl}/state.txt`)).text());
  console.log(`  Remote ${levelName}: seq=${remoteState.sequenceNumber}  ts=${remoteState.timestamp}`);
  console.log(`  PBF age: ${Math.round(ageMins)} min → using ${levelName} replication`);

  // Load or discover local state
  let localSeq: number;
  const stateKey = `sequenceNumber_${levelName}=`;

  if (existsSync(STATE_FILE)) {
    const txt  = readFileSync(STATE_FILE, "utf-8");
    const line = txt.split("\n").find(l => l.startsWith(stateKey));
    if (line) {
      localSeq = parseInt(line.slice(stateKey.length));
      console.log(`  Local ${levelName}: seq=${localSeq}`);
    } else {
      console.log(`  No ${levelName} state found – searching replication archive…`);
      localSeq = await findSequenceForTimestamp(replicationUrl, pbfTs, remoteState.sequenceNumber, lookback);
      console.log(`  Found starting seq: ${localSeq}`);
    }
  } else {
    console.log(`  No state file – searching ${levelName} replication archive for ${pbfTs}…`);
    localSeq = await findSequenceForTimestamp(replicationUrl, pbfTs, remoteState.sequenceNumber, lookback);
    console.log(`  Found starting seq: ${localSeq}`);
  }

  const pending = remoteState.sequenceNumber - localSeq;
  if (pending <= 0) {
    console.log("\n  ✓ Already up to date.");
    return;
  }
  console.log(`  Applying ${pending} diff(s): seq ${localSeq + 1} → ${remoteState.sequenceNumber}`);

  // ── Step 3: Download and apply diffs ─────────────────────────────────────────
  console.log("\n── Step 3: Applying replication diffs ───────────────────────────");
  let lastApplied = localSeq;

  for (let seq = localSeq + 1; seq <= remoteState.sequenceNumber; seq++) {
    const url = `${replicationUrl}/${seqToPath(seq)}.osc.gz`;
    try {
      const res    = await fetchRetry(url);
      const buf    = await res.arrayBuffer();
      const xml    = gunzipSync(Buffer.from(buf));
      applyOscBuffer(xml, dataset);
      lastApplied  = seq;
    } catch (e: any) {
      console.warn(`  ⚠ Skipping seq ${seq}: ${e?.message ?? e}`);
      continue;
    }

    const step = Math.max(1, Math.floor(pending / 20));
    if ((seq - localSeq) % step === 0 || seq === remoteState.sequenceNumber) {
      const pct = Math.round(100 * (seq - localSeq) / pending);
      console.log(`  [${pct}%] seq ${seq}  nodes=${dataset.nodes.size} ways=${dataset.ways.size} rels=${dataset.relations.size}`);
    }
  }
  console.log(`  Applied through seq ${lastApplied}`);

  // ── Step 4: Fetch missing dependencies from OSM API ───────────────────────────
  console.log("\n── Step 4: Fetching missing dependencies ────────────────────────");
  const limiter = new RateLimiter(API_RATE_LIMIT_MS, MAX_API_REQUESTS);

  // Two passes: second pass catches nodes of newly fetched ways
  for (let pass = 1; pass <= 2; pass++) {
    const missing = getMissingRefs(dataset);
    const total   = missing.nodes.size + missing.ways.size + missing.relations.size;
    if (total === 0) { console.log(`  ✓ No missing refs (pass ${pass})`); break; }

    const needReqs = Math.ceil(missing.nodes.size / BATCH_SIZE)
      + Math.ceil(missing.ways.size / BATCH_SIZE)
      + Math.ceil(missing.relations.size / BATCH_SIZE);

    console.log(`  Pass ${pass}: ${missing.nodes.size} nodes, ${missing.ways.size} ways, ` +
      `${missing.relations.size} relations  (~${needReqs} requests needed)`);

    try {
      if (missing.nodes.size > 0) {
        const els = await fetchOsmElements("nodes", [...missing.nodes], limiter);
        for (const el of els) dataset.nodes.set(el.id, el as OsmNode);
      }
      if (missing.ways.size > 0) {
        const els = await fetchOsmElements("ways", [...missing.ways], limiter);
        for (const el of els) dataset.ways.set(el.id, el as OsmWay);
      }
      if (missing.relations.size > 0) {
        const els = await fetchOsmElements("relations", [...missing.relations], limiter);
        for (const el of els) dataset.relations.set(el.id, el as OsmRelation);
      }
    } catch (e: any) {
      console.warn(`  ⚠ ${e?.message ?? e}`);
      break;
    }
  }
  console.log(`  Used ${limiter.count}/${MAX_API_REQUESTS} API requests`);

  // ── Step 5: Write output ──────────────────────────────────────────────────────
  console.log("\n── Step 5: Writing output ───────────────────────────────────────");
  const tempOut = "/tmp/osm-updater-output.osm";
  const xml     = writeOsmXml(dataset, remoteState.timestamp);
  writeFileSync(tempOut, xml, "utf-8");

  execSync(
    `osmium sort "${tempOut}" -o "${OUTPUT_PBF}" --overwrite ` +
    `--output-header="osmosis_replication_sequence_number=${lastApplied}" ` +
    `--output-header="osmosis_replication_timestamp=${remoteState.timestamp}" ` +
    `--output-header="generator=osm-climbing-updater"`,
    { stdio: "pipe" },
  );

  // Update state file (preserves other level sequences)
  const prevState = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf-8") : "";
  const updateLine = (text: string, key: string, value: string) => {
    const lines = text.split("\n").filter(l => l && !l.startsWith(key) && !l.startsWith("#") && !l.startsWith("timestamp="));
    return [`#osm-climbing-updater`, `timestamp=${remoteState.timestamp}`, ...lines, `${key}${value}`].join("\n") + "\n";
  };
  writeFileSync(STATE_FILE, updateLine(prevState, `sequenceNumber_${levelName}=`, String(lastApplied)));

  console.log(`  Written: ${OUTPUT_PBF}`);
  console.log(`  State:   ${STATE_FILE}`);
  console.log(`\n✓ Done — ${dataset.nodes.size} nodes, ${dataset.ways.size} ways, ${dataset.relations.size} relations`);
  console.log(`  API requests used: ${limiter.count}/${MAX_API_REQUESTS}`);
}
main().catch(e => {
  console.error("\n✗ Fatal:", e?.message ?? e);
  process.exit(1);
});
