import { err, ok, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";

export type ReviewOutcome = "no_action" | "actioned";

// An item is decided once; a later signal opens a new one rather than reopening it.
export function decideReviewOutcome(
    item: { readonly decidedAt: EpochMs | null } | null,
): Result<void, { readonly code: "NOT_FOUND" | "ALREADY_DECIDED" }> {
    if (item === null) return err({ code: "NOT_FOUND" });
    return item.decidedAt === null ? ok(undefined) : err({ code: "ALREADY_DECIDED" });
}
