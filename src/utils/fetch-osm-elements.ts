import {RateLimiter} from "./rate-limiter.ts";
import type {OsmElement, OsmNode, OsmRelation, OsmWay} from "./types.ts";
import {fetchRetry} from "./helpers.ts";

const OSM_API = "https://api.openstreetmap.org/api/0.6";

export const BATCH_SIZE = 100;  // element IDs per multi-get request

export async function fetchOsmElements(
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
        console.log(`  [API ${limiter.count}/${limiter.maxRequests}] GET ${type} (${batch.length} ids)`);

        const res = await fetchRetry(url);
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