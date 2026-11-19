import type { Clock } from "@lucent/core/clock";
import { err, ok, type Result } from "@lucent/core/result";

// Per-route token buckets in this process, keyed by the device key that signed the request's
// proof (checked first, so a key can't be named without holding it). A full bucket holds a
// minute's allowance and refills evenly. Per-IP limits in front of all of it are Caddy's.

export type RateRule = { readonly perMinute: number };

export type RateLimited = { readonly code: "RATE_LIMITED"; readonly retryAfterMs: number };

export type RateLimiter = {
    readonly take: (route: string, key: string) => Result<void, RateLimited>;
};

type Bucket = { tokens: number; updatedAt: number };

// Past this many buckets, full ones are dropped: a full bucket is the same as no bucket.
const PRUNE_AT = 10_000;

export function createRateLimiter(params: {
    readonly clock: Clock;
    readonly rules: Readonly<Record<string, RateRule>>;
}): RateLimiter {
    const buckets = new Map<string, Bucket>();
    const rules = new Map(Object.entries(params.rules));

    const refill = (bucket: Bucket, rule: RateRule, now: number): void => {
        const perMs = rule.perMinute / 60_000;
        bucket.tokens = Math.min(rule.perMinute, bucket.tokens + (now - bucket.updatedAt) * perMs);
        bucket.updatedAt = now;
    };

    const prune = (now: number): void => {
        for (const [id, bucket] of buckets) {
            const rule = rules.get(id.slice(0, id.indexOf(" ")));
            if (rule === undefined) continue;
            refill(bucket, rule, now);
            if (bucket.tokens >= rule.perMinute) buckets.delete(id);
        }
    };

    return {
        take(route, key) {
            const rule = rules.get(route);
            if (rule === undefined) return ok(undefined);
            const now = params.clock.now();
            const id = `${route} ${key}`;
            let bucket = buckets.get(id);
            if (bucket === undefined) {
                if (buckets.size >= PRUNE_AT) prune(now);
                bucket = { tokens: rule.perMinute, updatedAt: now };
                buckets.set(id, bucket);
            }
            refill(bucket, rule, now);
            if (bucket.tokens >= 1) {
                bucket.tokens -= 1;
                return ok(undefined);
            }
            const perMs = rule.perMinute / 60_000;
            return err({
                code: "RATE_LIMITED",
                retryAfterMs: Math.ceil((1 - bucket.tokens) / perMs),
            });
        },
    };
}
