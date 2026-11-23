import { err, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";
import type { Action } from "@lucent/policy/actions";
import { type Caller, can } from "@lucent/policy/policy";
import { readStanding } from "../authority/standing.ts";
import type { Db, DbFailure, Tx } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";

export const QUEUE_PAGE_SIZE = 25;

// A staff read takes no lock and needs no step-up: `can()` with the action decides, and every
// write taken from what was read is decided again under lock.
export function readAsStaff<T, E extends { readonly code: string }>(
    db: Db,
    params: { readonly caller: Caller; readonly action: Action },
    work: (tx: Tx, txNow: EpochMs) => Promise<Result<T, E>>,
) {
    return withTx<Result<T, E | DbFailure | { readonly code: "FORBIDDEN" }>>(
        db,
        async (tx, txNow) => {
            const standing = await readStanding(tx, params.caller.accountId, txNow);
            if (!standing.ok) return standing;
            if (
                standing.value === null ||
                !can({ ...standing.value, stepUpAt: params.caller.stepUpAt }, params.action)
            ) {
                return err({ code: "FORBIDDEN" as const });
            }
            return await work(tx, txNow);
        },
    );
}
