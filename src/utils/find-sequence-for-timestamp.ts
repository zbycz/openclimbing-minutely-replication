import {fetchRetry, parseState, seqToPath} from "./helpers.ts";

/**
 * Binary-search a replication archive to find the first sequence number
 * whose timestamp is ≥ targetTimestamp.
 */
export async function findSequenceForTimestamp(
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
            const url = `${replBase}/${seqToPath(mid)}.state.txt`;
            const text = await (await fetchRetry(url)).text();
            const ts = new Date(parseState(text).timestamp).getTime();
            if (ts < target) lo = mid + 1;
            else hi = mid;
        } catch {
            lo = mid + 1;
        }
    }
    return lo;
}