#!/usr/bin/env bun
/**
 * OSM Climbing Dataset Updater
 *
 * Downloads replication diffs from planet.openstreetmap.org and applies them
 * to a filtered dataset in Overpass JSON format (climbing + dependency closure).
 * Missing referenced elements are fetched from the live OSM API using multi-get.
 *
 * Usage: bun run osm-update.ts input.json [output.json]
 *
 * Input JSON format (produced by pbf_to_overpass_json.py):
 *   { "osm3s": { "timestamp_osm_base": "..." }, "elements": [...] }
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";

// ─── Configuration ────────────────────────────────────────────────────────────

if (!process.argv[2]) { console.error("Usage: bun run osm-update.ts input.json [output.json]"); process.exit(1); }

const INPUT_FILE  = process.argv[2] as string;
const OUTPUT_FILE = process.argv[3] ?? INPUT_FILE.replace(/\.json$/, ".updated.json");
const STATE_FILE  = INPUT_FILE + ".state.json";

const OSM_API = "https://api.openstreetmap.org/api/0.6";

// Replication levels — day diffs are ~1 GB decompressed; we top out at hour
const REPLICATIONS_MINUTE_URL = "https://planet.openstreetmap.org/replication/minute";
const REPLICATIONS_HOUR_URL   = "https://planet.openstreetmap.org/replication/hour";
const MINUTE_THRESHOLD = 120; // use hour replication when > 2 h of diffs pending

const MAX_API_REQUESTS  = 100;  // abort dependency fetch after this many OSM API calls
const API_RATE_LIMIT_MS = 1200; // ≥ 1 s between calls (OSM API policy)
const BATCH_SIZE        = 100;  // element IDs per multi-get request

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
  nodes:     Map<number, OsmNode>;
  ways:      Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
}

interface ReplicationState {
  sequenceNumber: number;
  timestamp: string;
}

interface StateFile {
  sequenceNumber_minute?: number;
  sequenceNumber_hour?:   number;
  timestamp?: string;
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

// ─── Climbing filter ──────────────────────────────────────────────────────────

/**
 * Returns true if the element is a "climbing" element that belongs
 * in this filtered dataset (regardless of whether it's already present).
 *
 *     osmium tags-filter \
 *         planet-260316.osm.pbf \
 *         'nwr/climbing*' \
 *         nwr/sport=climbing \
 *         nwr/sport=via_ferrata \
 *         --overwrite \
 *         --progress \
 *         -o filtered.osm.pbf
 */
function isClimbing(tags: Record<string, string>): boolean {
  if (!tags || Object.keys(tags).length === 0) return false;
  return (
    tags["sport"] === "climbing" ||
    tags["sport"] === "via_ferrata" ||
    tags["leisure"] === "climbing" ||
    "climbing" in tags ||
    Object.keys(tags).some(k => k.startsWith("climbing"))
  );
}

// ─── JSON I/O ─────────────────────────────────────────────────────────────────

/** Load Overpass-format JSON into an in-memory Dataset. */
function loadJson(path: string): { dataset: Dataset; timestamp: string } {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const dataset: Dataset = { nodes: new Map(), ways: new Map(), relations: new Map() };

  for (const el of raw.elements ?? []) {
    if (el.type === "node") {
      dataset.nodes.set(el.id, {
        type: "node",
        id: el.id, version: el.version ?? 0, timestamp: el.timestamp ?? "",
        uid: el.uid ?? 0, user: el.user ?? "", changeset: el.changeset ?? 0,
        lat: el.lat, lon: el.lon, tags: el.tags ?? {},
      });
    } else if (el.type === "way") {
      dataset.ways.set(el.id, {
        type: "way",
        id: el.id, version: el.version ?? 0, timestamp: el.timestamp ?? "",
        uid: el.uid ?? 0, user: el.user ?? "", changeset: el.changeset ?? 0,
        nodes: el.nodes ?? [], tags: el.tags ?? {},
      });
    } else if (el.type === "relation") {
      dataset.relations.set(el.id, {
        type: "relation",
        id: el.id, version: el.version ?? 0, timestamp: el.timestamp ?? "",
        uid: el.uid ?? 0, user: el.user ?? "", changeset: el.changeset ?? 0,
        members: (el.members ?? []).map((m: any) => ({
          type: m.type as "node" | "way" | "relation",
          ref: m.ref, role: m.role ?? "",
        })),
        tags: el.tags ?? {},
      });
    }
  }

  return { dataset, timestamp: raw.osm3s?.timestamp_osm_base ?? "" };
}

/** Serialize Dataset back to Overpass-format JSON and write to disk. */
function saveJson(path: string, dataset: Dataset, timestamp: string): void {
  const elements: any[] = [];

  for (const n of [...dataset.nodes.values()].sort((a, b) => a.id - b.id)) {
    const el: any = { type: "node", id: n.id, lat: n.lat, lon: n.lon };
    if (Object.keys(n.tags).length > 0) el.tags = n.tags;
    elements.push(el);
  }
  for (const w of [...dataset.ways.values()].sort((a, b) => a.id - b.id)) {
    const el: any = { type: "way", id: w.id, nodes: w.nodes };
    if (Object.keys(w.tags).length > 0) el.tags = w.tags;
    elements.push(el);
  }
  for (const r of [...dataset.relations.values()].sort((a, b) => a.id - b.id)) {
    const el: any = { type: "relation", id: r.id, members: r.members };
    if (Object.keys(r.tags).length > 0) el.tags = r.tags;
    elements.push(el);
  }

  const out = { osm3s: { timestamp_osm_base: timestamp }, elements };
  writeFileSync(path, JSON.stringify(out, null, 2), "utf-8");
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
        id: +(a["id"] ?? 0), version: +(a["version"] ?? 0), timestamp: a["timestamp"] ?? "",
        uid: +(a["uid"] ?? 0), user: a["user"] ?? "", changeset: +(a["changeset"] ?? 0),
        lat: numAttr(a, "lat"), lon: numAttr(a, "lon"),
        tags: {},
      };
    } else if (name === "way") {
      curWay = {
        type: "way",
        id: +(a["id"] ?? 0), version: +(a["version"] ?? 0), timestamp: a["timestamp"] ?? "",
        uid: +(a["uid"] ?? 0), user: a["user"] ?? "", changeset: +(a["changeset"] ?? 0),
        nodes: [], tags: {},
      };
    } else if (name === "relation") {
      curRelation = {
        type: "relation",
        id: +(a["id"] ?? 0), version: +(a["version"] ?? 0), timestamp: a["timestamp"] ?? "",
        uid: +(a["uid"] ?? 0), user: a["user"] ?? "", changeset: +(a["changeset"] ?? 0),
        members: [], tags: {},
      };
    } else if (name === "tag") {
      const el = curNode ?? curWay ?? curRelation;
      const k = a["k"], v = a["v"];
      if (el?.tags && k != null && v != null) el.tags[k] = v;
    } else if (name === "nd" && curWay?.nodes) {
      curWay.nodes.push(+(a["ref"] ?? 0));
    } else if (name === "member" && curRelation?.members) {
      curRelation.members.push({
        type: (a["type"] ?? "node") as "node" | "way" | "relation",
        ref: +(a["ref"] ?? 0),
        role: a["role"] ?? "",
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  OSM Climbing Dataset Updater            ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log(`Input:  ${INPUT_FILE}`);
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log(`State:  ${STATE_FILE}\n`);

  // ── Step 1: Read current JSON ────────────────────────────────────────────────
  console.log("── Step 1: Reading JSON ─────────────────────────────────────────");
  const { dataset, timestamp: inputTs } = loadJson(INPUT_FILE);
  if (!inputTs) throw new Error("Could not read timestamp_osm_base from input JSON (osm3s field)");
  console.log(`  Loaded: ${dataset.nodes.size} nodes, ${dataset.ways.size} ways, ${dataset.relations.size} relations`);
  console.log(`  Timestamp: ${inputTs}`);

  // ── Step 2: Choose replication level and find sequences ──────────────────────
  console.log("\n── Step 2: Replication state ────────────────────────────────────");

  const ageMins = (Date.now() - new Date(inputTs).getTime()) / 60_000;
  let replicationUrl: string;
  let levelName: string;
  let lookback: number;

  if (ageMins <= MINUTE_THRESHOLD) {
    replicationUrl = REPLICATIONS_MINUTE_URL; levelName = "minute"; lookback = 43_200;
  } else {
    replicationUrl = REPLICATIONS_HOUR_URL;   levelName = "hour";   lookback = 8_760;
  }

  const remoteState = parseState(await (await fetchRetry(`${replicationUrl}/state.txt`)).text());
  console.log(`  Remote ${levelName}: seq=${remoteState.sequenceNumber}  ts=${remoteState.timestamp}`);
  console.log(`  Data age: ${Math.round(ageMins)} min → using ${levelName} replication`);

  // Load or discover local sequence number
  const stateKey = `sequenceNumber_${levelName}` as "sequenceNumber_minute" | "sequenceNumber_hour";
  let localSeq: number;

  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as StateFile;
    if (saved[stateKey] != null) {
      localSeq = saved[stateKey] as number;
      console.log(`  Local ${levelName}: seq=${localSeq}`);
    } else {
      console.log(`  No ${levelName} state found – searching replication archive…`);
      localSeq = await findSequenceForTimestamp(replicationUrl, inputTs, remoteState.sequenceNumber, lookback);
      console.log(`  Found starting seq: ${localSeq}`);
    }
  } else {
    console.log(`  No state file – searching ${levelName} replication archive for ${inputTs}…`);
    localSeq = await findSequenceForTimestamp(replicationUrl, inputTs, remoteState.sequenceNumber, lookback);
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
      const res   = await fetchRetry(url);
      const buf   = await res.arrayBuffer();
      const xml   = gunzipSync(Buffer.from(buf));
      applyOscBuffer(xml, dataset);
      lastApplied = seq;
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

  // ── Step 4: Fetch missing dependencies from OSM API ──────────────────────────
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
  saveJson(OUTPUT_FILE, dataset, remoteState.timestamp);

  // Update state file (preserves both minute and hour sequences)
  const prevState: StateFile = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf-8"))
    : {};
  prevState[stateKey] = lastApplied;
  prevState.timestamp = remoteState.timestamp;
  writeFileSync(STATE_FILE, JSON.stringify(prevState, null, 2), "utf-8");

  console.log(`  Written: ${OUTPUT_FILE}`);
  console.log(`  State:   ${STATE_FILE}`);
  console.log(`\n✓ Done — ${dataset.nodes.size} nodes, ${dataset.ways.size} ways, ${dataset.relations.size} relations`);
  console.log(`  API requests used: ${limiter.count}/${MAX_API_REQUESTS}`);
}
main().catch(e => {
  console.error("\n✗ Fatal:", e?.message ?? e);
  process.exit(1);
});
