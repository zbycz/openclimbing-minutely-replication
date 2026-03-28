import type {ReplicationState} from "./types.ts";

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Parse a planet.openstreetmap.org state.txt file */
export function parseState(text: string): ReplicationState {
    const get = (prefix: string) =>
        text.split("\n").find(l => l.startsWith(prefix))?.slice(prefix.length) ?? "";
    return {
        sequenceNumber: parseInt(get("sequenceNumber=")),
        timestamp: get("timestamp=").replace(/\\\:/g, ":"),
    };
}

/** Convert sequence number → directory path component (e.g. 7044482 → 007/044/482) */
export function seqToPath(seq: number): string {
    const s = seq.toString().padStart(9, "0");
    return `${s.slice(0, 3)}/${s.slice(3, 6)}/${s.slice(6, 9)}`;
}

/** Fetch with automatic redirect following and simple retry */
export async function fetchRetry(url: string, retries = 3): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                headers: {"User-Agent": "osm-climbing-updater/1.0 (bun)"},
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