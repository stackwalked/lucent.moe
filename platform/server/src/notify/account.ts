import { ok, type Result } from "@lucent/core/result";
import type { AccountId, BearerToken } from "@lucent/core/scalars";
import { lockSession } from "../auth/sessions.ts";
import type { Db, DbFailure, Tx } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";

export function withMember<S extends Result<unknown, unknown>>(
    db: Db,
    token: BearerToken,
    work: (tx: Tx, accountId: AccountId) => Promise<S>,
) {
    return withTx(db, async (tx, txNow) => {
        const member = await lockSession(tx, { token, txNow, purposes: ["member"] });
        if (!member.ok) return member;
        return await work(tx, member.value.accountId);
    });
}

export function written(result: Result<number, DbFailure>) {
    return result.ok ? ok(undefined) : result;
}
