import {sleep} from "./helpers.ts";

export class RateLimiter {
    private lastCall = 0;
    private _count = 0;

    constructor(
        private readonly minIntervalMs: number,
        public readonly maxRequests: number,
    ) {
    }

    get count() {
        return this._count;
    }

    async throttle(): Promise<void> {
        if (this._count >= this.maxRequests)
            throw new Error(`Reached maximum of ${this.maxRequests} OSM API requests – stopping dependency fetch`);
        const elapsed = Date.now() - this.lastCall;
        if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed);
        this.lastCall = Date.now();
        this._count++;
    }
}