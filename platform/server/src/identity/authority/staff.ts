import { err, ok, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";
import type { Action } from "@lucent/policy/actions";
import { type AuthzRefusal, authorize, type Caller, can } from "@lucent/policy/policy";
import type { Db, DbFailure, Queryable, Tx } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { lockCallerWith, readStanding } from "./standing.ts";

export type Forbidden = { readonly code: "FORBIDDEN" };

// A staff read: no locks and no step-up, as in authority/reads.ts. `can()` with any of `actions`
// decides, and whatever is done with what was read is decided again under lock.
export async function readAsStaff<T, E>(
    db: Db,
    params: { readonly caller: Caller; readonly actions: readonly Action[] },
    read: (q: Queryable, txNow: EpochMs) => Promise<Result<T, E>>,
): Promise<Result<T, E | Forbidden | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const standing = await readStanding(tx, params.caller.accountId, txNow);
        if (!standing.ok) return standing;
        if (standing.value === null) return err({ code: "FORBIDDEN" as const });
        const subject = { ...standing.value, stepUpAt: params.caller.stepUpAt };
        if (!params.actions.some((action) => can(subject, action))) {
            return err({ code: "FORBIDDEN" as const });
        }
        return await read(tx, txNow);
    });
}

// The caller locked first, as every writer does, and authorized for `action` under the step-up
// rule.
export async function lockAuthorized(
    tx: Tx,
    params: { readonly caller: Caller; readonly action: Action; readonly txNow: EpochMs },
): Promise<Result<void, AuthzRefusal | DbFailure>> {
    const locked = await lockCallerWith(tx, {
        caller: params.caller,
        targets: [],
        txNow: params.txNow,
    });
    if (!locked.ok) return locked;
    const authz = authorize({
        txNow: params.txNow,
        subject: locked.value.subject,
        action: params.action,
    });
    return authz.ok ? ok(undefined) : authz;
}
