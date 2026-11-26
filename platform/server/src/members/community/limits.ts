import type { Result } from "@lucent/core/result";
import { type AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type DbFailure, queryOne, sql, type Tx, toTimestamptz } from "../../base/db/pool.ts";
import { decidePostRate, type LimitRefusal, POST_WINDOW_MS } from "./limits.rules.ts";

// Comments and shouts of the account in the last window, counted under the account's lock (the
// session lock every writer holds), so two posts at once cannot both slip under the limit. The
// window is the transaction's clock.
export async function checkPostRate(
    tx: Tx,
    params: { readonly accountId: AccountId; readonly txNow: EpochMs },
): Promise<Result<null, LimitRefusal | DbFailure>> {
    const since = toTimestamptz(EpochMs.parse(params.txNow - POST_WINDOW_MS));
    const counted = await queryOne(
        tx,
        z.object({ recent: z.coerce.number() }),
        sql`select (select count(*) from comment where author_id = ${params.accountId} and created_at > ${since}::timestamptz)
                 + (select count(*) from shout where author_id = ${params.accountId} and created_at > ${since}::timestamptz) as recent`,
    );
    if (!counted.ok) return counted;
    return decidePostRate(counted.value?.recent ?? 0);
}
