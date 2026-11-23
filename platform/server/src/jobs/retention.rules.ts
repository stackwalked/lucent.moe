import { ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

// How long each kind of row is kept (wishlist/protection.md, "Signals": integrity signals, review
// evidence and raw IP addresses a year, health events a month).
export type RetentionTier = "30d" | "90d" | "365d" | "forever";

const DAY_MS = 24 * 60 * 60 * 1_000;

const TIER_DAYS: Readonly<Record<Exclude<RetentionTier, "forever">, number>> = {
    "30d": 30,
    "90d": 90,
    "365d": 365,
};

// Rows older than the cutoff go; a forever tier has none.
export function decideRetentionCutoff(
    tier: RetentionTier,
    txNow: EpochMs,
): Result<EpochMs | null, never> {
    if (tier === "forever") return ok(null);
    return ok(EpochMs.parse(Math.max(0, txNow - TIER_DAYS[tier] * DAY_MS)));
}
