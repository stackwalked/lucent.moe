import type { Result } from "@lucent/core/result";
import type { AccountId, BearerToken, EpochMs } from "@lucent/core/scalars";
import type { Db, Tx } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { lockSession } from "../../identity/auth/sessions.ts";

// The member's session locked for writing, with the transaction's own clock: what time-sensitive
// community decisions (restrictions, windows) compare against. The session lock holds the
// account row, so a restriction being set waits for work in flight and the reverse.
export function withMemberAt<S extends Result<unknown, unknown>>(
    db: Db,
    token: BearerToken,
    work: (tx: Tx, accountId: AccountId, txNow: EpochMs) => Promise<S>,
) {
    return withTx(db, async (tx, txNow) => {
        const member = await lockSession(tx, { token, txNow, purposes: ["member"] });
        if (!member.ok) return member;
        return await work(tx, member.value.accountId, txNow);
    });
}
