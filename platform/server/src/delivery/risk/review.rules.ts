import { err, ok, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";

export type ReviewOutcome = "no_action" | "actioned";

// An item is decided once; a later signal opens a new one rather than reopening it. Nobody
// decides an item about their own account, as no staff action targets the caller's own.
export function decideReviewOutcome(params: {
    readonly item: { readonly accountId: string; readonly decidedAt: EpochMs | null } | null;
    readonly callerId: string;
}): Result<void, { readonly code: "NOT_FOUND" | "ALREADY_DECIDED" | "FORBIDDEN" }> {
    const { item } = params;
    if (item === null) return err({ code: "NOT_FOUND" });
    if (item.accountId === params.callerId) return err({ code: "FORBIDDEN" });
    return item.decidedAt === null ? ok(undefined) : err({ code: "ALREADY_DECIDED" });
}
