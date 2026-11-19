import type { Clock } from "@lucent/core/clock";

// Per-IP token buckets, the one piece of state web keeps between requests. Losing it on restart
// only resets the limits.
export type Throttle = {
    // Takes a token from `key`'s bucket in `bucket`; false when it's empty.
    readonly take: (bucket: Bucket, key: string) => boolean;
};

export type Bucket = { readonly name: string; readonly perMinute: number };

export const BUCKETS = {
    overall: { name: "overall", perMinute: 300 },
    signIn: { name: "signIn", perMinute: 10 },
    setupRedeem: { name: "setup.redeem", perMinute: 5 },
    stepUp: { name: "stepUp", perMinute: 10 },
    report: { name: "report", perMinute: 60 },
} as const satisfies Record<string, Bucket>;

const MINUTE_MS = 60_000;

type State = { tokens: number; at: number };

// A bucket idle for a minute is full again, so it can be forgotten; past `maxKeys` the full ones
// are swept, which bounds memory however many addresses show up.
export function createThrottle(params: {
    readonly clock: Clock;
    readonly maxKeys?: number;
}): Throttle {
    const maxKeys = params.maxKeys ?? 100_000;
    const states = new Map<string, State>();

    const sweep = (now: number): void => {
        for (const [id, state] of states) {
            if (now - state.at >= MINUTE_MS) states.delete(id);
        }
    };

    return {
        take: (bucket, key) => {
            const now = params.clock.now();
            const id = `${bucket.name}|${key}`;
            const state = states.get(id);
            const refill =
                state === undefined
                    ? bucket.perMinute
                    : ((now - state.at) * bucket.perMinute) / MINUTE_MS;
            const tokens = Math.min(bucket.perMinute, (state?.tokens ?? 0) + refill);
            if (tokens < 1) {
                states.set(id, { tokens, at: now });
                return false;
            }
            if (state === undefined && states.size >= maxKeys) sweep(now);
            states.set(id, { tokens: tokens - 1, at: now });
            return true;
        },
    };
}
