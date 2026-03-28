import type {Dataset} from "./types.ts";
import {readFileSync, writeFileSync} from "fs";

/** Load Overpass-format JSON into an in-memory Dataset. */
export function loadJson(path: string): { dataset: Dataset; timestamp: string } {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const dataset: Dataset = {nodes: new Map(), ways: new Map(), relations: new Map()};

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

    return {dataset, timestamp: raw.osm3s?.timestamp_osm_base ?? ""};
}

/** Serialize Dataset back to Overpass-format JSON and write to disk. */
export function saveJson(path: string, dataset: Dataset, timestamp: string): void {
    const elements: any[] = [];

    for (const n of [...dataset.nodes.values()].sort((a, b) => a.id - b.id)) {
        const el: any = {type: "node", id: n.id, lat: n.lat, lon: n.lon};
        if (Object.keys(n.tags).length > 0) el.tags = n.tags;
        elements.push(el);
    }
    for (const w of [...dataset.ways.values()].sort((a, b) => a.id - b.id)) {
        const el: any = {type: "way", id: w.id, nodes: w.nodes};
        if (Object.keys(w.tags).length > 0) el.tags = w.tags;
        elements.push(el);
    }
    for (const r of [...dataset.relations.values()].sort((a, b) => a.id - b.id)) {
        const el: any = {type: "relation", id: r.id, members: r.members};
        if (Object.keys(r.tags).length > 0) el.tags = r.tags;
        elements.push(el);
    }

    const out = {osm3s: {timestamp_osm_base: timestamp}, elements};
    writeFileSync(path, JSON.stringify(out, null, 2), "utf-8");
}