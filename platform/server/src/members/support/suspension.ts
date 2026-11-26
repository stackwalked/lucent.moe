import { ok } from "@lucent/core/result";
import { type AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Queryable, queryOne, sql } from "../../base/db/pool.ts";

// The reason staff gave when they last suspended the account, as the audit row keeps it, and
// when. This is all an appeal shows of why: nothing more is stored. Null when no audit row names
// the suspension (one set straight in the database).
export type Suspension = { readonly reason: string; readonly at: EpochMs };

export async function findSuspension(q: Queryable, accountId: AccountId) {
    const row = await queryOne(
        q,
        z.object({ reason: z.string().nullable(), at: EpochMs }),
        sql`select target ->> 'reason' as reason, at from audit
            where operation = 'account.suspend' and target ->> 'accountId' = ${accountId}
            order by id desc limit 1`,
    );
    if (!row.ok) return row;
    if (row.value === null || row.value.reason === null) return ok(null);
    return ok<Suspension>({ reason: row.value.reason, at: row.value.at });
}
