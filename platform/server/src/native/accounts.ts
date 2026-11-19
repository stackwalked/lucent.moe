import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId, EpochMs } from "@lucent/core/scalars";
import { lockCallerWith } from "../authority/standing.ts";
import type { DbFailure, Tx } from "../db/pool.ts";

export type AccountInactive = { readonly code: "ACCOUNT_SUSPENDED" };

// The account a native request acts for, locked first as every writer does (platform/AGENTS.md),
// so a suspension committed a moment ago is seen here. A loader holds no step-up, and none of
// its requests needs one.
export async function lockActiveAccount(
    tx: Tx,
    accountId: AccountId,
    txNow: EpochMs,
): Promise<Result<void, AccountInactive | DbFailure>> {
    const locked = await lockCallerWith(tx, {
        caller: { accountId, stepUpAt: null, client: null },
        targets: [],
        txNow,
    });
    if (!locked.ok) {
        // An authz refusal here means the account row is gone, which never happens (accounts
        // aren't deleted); it's no account to act for either way.
        return locked.error.code === "FORBIDDEN" || locked.error.code === "STEP_UP_REQUIRED"
            ? err({ code: "ACCOUNT_SUSPENDED" })
            : err(locked.error);
    }
    return locked.value.subject.isActive ? ok(undefined) : err({ code: "ACCOUNT_SUSPENDED" });
}

// The account locked, active or not: a renewal ends a suspended account's session rather than
// only refusing it, so it needs the answer, not a refusal.
export async function lockAccountStanding(
    tx: Tx,
    accountId: AccountId,
    txNow: EpochMs,
): Promise<Result<"active" | "inactive", DbFailure>> {
    const locked = await lockActiveAccount(tx, accountId, txNow);
    if (locked.ok) return ok("active");
    return locked.error.code === "ACCOUNT_SUSPENDED" ? ok("inactive") : err(locked.error);
}
