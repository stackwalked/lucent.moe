import { type Ok, ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

// A DM that fails for any reason but the member's own (DMs closed, the bot blocked) is tried
// again after each of these, about an hour in all, then dropped: the inbox entry is the notice,
// the DM only points at it.
const RETRY_AFTER_MS = [5 * 60_000, 15 * 60_000, 40 * 60_000] as const;
// Older than this, a DM would point at news nobody needs pointed at any more: the connector was
// away, and the inbox has it.
const STALE_AFTER_MS = 24 * 60 * 60_000;

export type DmOutcome = "sent" | "refused" | "failed";

export type DmSettlement =
    | { readonly action: "remove" }
    | { readonly action: "retry"; readonly attempts: number; readonly nextAttemptAt: EpochMs };

// `attempts`: how many tries had already failed before this one.
export function decideDmSettlement(params: {
    readonly attempts: number;
    readonly outcome: DmOutcome;
    readonly txNow: EpochMs;
}): Ok<DmSettlement> {
    if (params.outcome !== "failed") return ok({ action: "remove" });
    const wait = RETRY_AFTER_MS[params.attempts];
    if (wait === undefined) return ok({ action: "remove" });
    return ok({
        action: "retry",
        attempts: params.attempts + 1,
        nextAttemptAt: EpochMs.parse(params.txNow + wait),
    });
}

// DMs queued at or before this are dropped unsent.
export function decideDmStaleCutoff(txNow: EpochMs): Ok<EpochMs> {
    return ok(EpochMs.parse(Math.max(0, txNow - STALE_AFTER_MS)));
}
