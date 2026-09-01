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

import {existsSync, readFileSync, writeFileSync} from "fs";
import {gunzipSync} from "zlib";
import type {OsmNode, OsmRelation, OsmWay, ReplicationState, StateFile, StateKey} from "./utils/types.ts";
import {fetchRetry, parseState, seqToPath} from "./utils/helpers.ts";
import {loadJson, saveJson} from "./utils/json.ts";
import {applyOscBuffer} from "./utils/apply-osc-buffer.ts";
import {RateLimiter} from "./utils/rate-limiter.ts";
import {getMissingRefs} from "./utils/get-missing-refs.ts";
import {findSequenceForTimestamp} from "./utils/find-sequence-for-timestamp.ts";
import {BATCH_SIZE, fetchOsmElements} from "./utils/fetch-osm-elements.ts";

// ─── Configuration ────────────────────────────────────────────────────────────

if (!process.argv[2]) { console.error("Usage: bun run osm-update.ts input.json [output.json]"); process.exit(1); }

const INPUT_FILE  = process.argv[2] as string;
const OUTPUT_FILE = process.argv[3] ?? INPUT_FILE.replace(/\.json$/, ".updated.json");
const STATE_FILE  = INPUT_FILE + ".state.json";

// Replication levels — day diffs are ~1 GB decompressed; we top out at hour
const REPLICATIONS_MINUTE_URL = "https://planet.openstreetmap.org/replication/minute";
const REPLICATIONS_HOUR_URL   = "https://planet.openstreetmap.org/replication/hour";
const MINUTE_THRESHOLD = 120; // use hour replication when > 2 h of diffs pending

const MAX_API_REQUESTS  = 100;  // abort dependency fetch after this many OSM API calls
const API_RATE_LIMIT_MS = 1200; // ≥ 1 s between calls (OSM API policy)
const limiter = new RateLimiter(API_RATE_LIMIT_MS, MAX_API_REQUESTS);


// ─── Main ─────────────────────────────────────────────────────────────────────

const updateStateFile = (stateKey: "sequenceNumber_minute" | "sequenceNumber_hour", lastApplied: number, remoteState: ReplicationState) => {
  const prevState: StateFile = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, "utf-8"))
      : {};
  prevState[stateKey] = lastApplied;
  prevState.timestamp = remoteState.timestamp;
  writeFileSync(STATE_FILE, JSON.stringify(prevState, null, 2), "utf-8");
}

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

  // overpass.json is rewritten only when a climbing element actually changed, so
  // its timestamp lags to the last climbing edit worldwide (regularly many hours).
  // The state file is written on every run, so it - not inputTs - tells how far
  // behind the replication stream we really are.
  const savedState: StateFile = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, "utf-8"))
      : {};
  const stateIsCurrent = savedState.timestamp != null
      && new Date(savedState.timestamp).getTime() >= new Date(inputTs).getTime();
  const baseTs = stateIsCurrent ? savedState.timestamp as string : inputTs;

  const ageMins = (Date.now() - new Date(baseTs).getTime()) / 60_000;
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
  console.log(`  Data age: ${Math.round(ageMins)} min (since ${baseTs}) → using ${levelName} replication`);

  // Load or discover local sequence number
  const stateKey = `sequenceNumber_${levelName}` as StateKey;
  let localSeq: number;

  const savedSeq = stateIsCurrent ? savedState[stateKey] : undefined;
  if (savedSeq != null) {
    localSeq = savedSeq;
    console.log(`  Local ${levelName}: seq=${localSeq}`);
  } else {
    console.log(`  No ${levelName} state for ${baseTs} – searching replication archive…`);
    localSeq = await findSequenceForTimestamp(replicationUrl, baseTs, remoteState.sequenceNumber, lookback);
    console.log(`  Found starting seq: ${localSeq}`);
  }

  const pending = remoteState.sequenceNumber - localSeq;
  if (pending <= 0) {
    console.log("\n  ✓ Already up to date, returning error code to break the script.");
    process.exit(1);
  }
  console.log(`  Applying ${pending} diff(s): seq ${localSeq + 1} → ${remoteState.sequenceNumber}`);

  // ── Step 3: Download and apply diffs ─────────────────────────────────────────
  console.log("\n── Step 3: Applying replication diffs ───────────────────────────");
  let changesMade = 0;
  let lastApplied = localSeq;

  for (let seq = localSeq + 1; seq <= remoteState.sequenceNumber; seq++) {
    const url = `${replicationUrl}/${seqToPath(seq)}.osc.gz`;
    try {
      const res   = await fetchRetry(url);
      const buf   = await res.arrayBuffer();
      const xml   = gunzipSync(Buffer.from(buf));
      changesMade += applyOscBuffer(xml, dataset);
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
  console.log(`  Changes made: ${changesMade}`);
  if (changesMade === 0) {
    console.log("\n  ✓ No changes to climbing-related elements, returning error code to break the script.");
    updateStateFile(stateKey, lastApplied, remoteState);
    process.exit(1);
  }

  // ── Step 4: Fetch missing dependencies from OSM API ──────────────────────────
  console.log("\n── Step 4: Fetching missing dependencies ────────────────────────");

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

  updateStateFile(stateKey, lastApplied, remoteState);

  console.log(`  Written: ${OUTPUT_FILE}`);
  console.log(`  State:   ${STATE_FILE}`);
  console.log(`\n✓ Done — ${dataset.nodes.size} nodes, ${dataset.ways.size} ways, ${dataset.relations.size} relations`);
  console.log(`  API requests used: ${limiter.count}/${MAX_API_REQUESTS}`);
}
main().catch(e => {
  console.error("\n✗ Fatal:", e?.message ?? e);
  process.exit(1);
});
