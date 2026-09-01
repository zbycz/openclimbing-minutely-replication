import type {Dataset, OsmNode, OsmRelation, OsmWay} from "./types.ts";
import sax from "sax";
import {StringDecoder} from "string_decoder";
import {isClimbing} from "./filter.ts";

// ─── OSC diff: streaming SAX application ─────────────────────────────────────
// Hour diffs decompress to ~35 MB; we stream-parse with SAX so the full XML
// DOM is never in memory — only the element being parsed.

/**
 * Parse a decompressed OSC XML buffer with a streaming SAX parser and apply
 * each change directly to `dataset`.  Peak extra memory ≈ size of one element.
 */
export function applyOscBuffer(buf: Buffer, dataset: Dataset): number {
    let changesMade = 0;
    const commit = (el: OsmNode | OsmWay | OsmRelation) => {
        if (action === "delete") {
            if (el.type === "node" && dataset.nodes.has(el.id)) {
                dataset.nodes.delete(el.id);
                changesMade += 1;
            }
            else if (el.type === "way" && dataset.ways.has(el.id)) {
                dataset.ways.delete(el.id);
                changesMade += 1;
            }
            else if (el.type === "relation" && dataset.relations.has(el.id)) {
                dataset.relations.delete(el.id);
                changesMade += 1;
            }
            return;
        }
        // create / modify: keep if already in dataset OR newly climbing
        const inDataset =
            (el.type === "node" && dataset.nodes.has(el.id)) ||
            (el.type === "way" && dataset.ways.has(el.id)) ||
            (el.type === "relation" && dataset.relations.has(el.id));

        if (inDataset || isClimbing(el.tags)) {
            changesMade += 1;
            if (el.type === "node") dataset.nodes.set(el.id, el as OsmNode);
            else if (el.type === "way") dataset.ways.set(el.id, el as OsmWay);
            else if (el.type === "relation") dataset.relations.set(el.id, el as OsmRelation);
        }
    };

    const parser = sax.parser(true /* strict */);

    // Current action context: "create" | "modify" | "delete"
    let action: "create" | "modify" | "delete" | null = null;

    // Element being built
    let curNode: Partial<OsmNode> | null = null;
    let curWay: Partial<OsmWay> | null = null;
    let curRelation: Partial<OsmRelation> | null = null;

    const attr = (attrs: Record<string, string>, k: string, fallback = "") =>
        attrs[k] ?? fallback;
    const numAttr = (attrs: Record<string, string>, k: string) =>
        parseFloat(attrs[k] ?? "0");

    parser.onopentag = ({name, attributes: _a}) => {
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

        if (name === "node" && curNode) {
            commit(curNode as OsmNode);
            curNode = null;
        }
        if (name === "way" && curWay) {
            commit(curWay as OsmWay);
            curWay = null;
        }
        if (name === "relation" && curRelation) {
            commit(curRelation as OsmRelation);
            curRelation = null;
        }
    };

    parser.onerror = (e) => {
        throw e;
    };

    // Feed in chunks to avoid one giant string allocation. StringDecoder holds
    // back a multi-byte character split across a chunk boundary - a plain
    // toString() would turn it into U+FFFD and silently corrupt the tag value.
    const CHUNK = 256 * 1024;
    const decoder = new StringDecoder("utf-8");
    for (let off = 0; off < buf.length; off += CHUNK)
        parser.write(decoder.write(buf.subarray(off, off + CHUNK)));
    parser.write(decoder.end());
    parser.close();

    return changesMade;
}