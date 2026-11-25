import { ok, type Result } from "@lucent/core/result";
import { type AccountId, type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, type DbFailure, type Queryable, queryAll, sql, type Tx } from "../db/pool.ts";
import { withMember } from "../notify/account.ts";
import {
    decidePosting,
    type PostingRefusal,
    type PostingSurface,
    RESTRICTION_KINDS,
    type Restriction,
} from "./standing.rules.ts";

const RestrictionRow = z.object({
    kind: z.enum(RESTRICTION_KINDS),
    productId: ProductId.nullable(),
    endsAt: EpochMs.nullable(),
});

// An expired row the job has not lifted yet is no restriction: now() is the transaction's.
export function readActiveRestrictions(
    q: Queryable,
    accountId: AccountId,
): Promise<Result<readonly Restriction[], DbFailure>> {
    return queryAll(
        q,
        RestrictionRow,
        sql`select kind, product_id as "productId", ends_at as "endsAt"
            from community_restriction
            where account_id = ${accountId} and lifted_at is null
              and (ends_at is null or ends_at > now())
            order by created_at, id`,
    );
}

// Every writer of member-written content calls this inside its own transaction after the
// session lock, which holds the account row: a restriction committed a moment ago is seen, and
// one being set waits for the writer. It reads only community_restriction.
export async function mayPostHere(
    tx: Tx,
    params: {
        readonly accountId: AccountId;
        readonly surface: PostingSurface;
        readonly productId: ProductId | null;
        readonly txNow: EpochMs;
    },
): Promise<Result<null, PostingRefusal | DbFailure>> {
    const restrictions = await readActiveRestrictions(tx, params.accountId);
    if (!restrictions.ok) return restrictions;
    return decidePosting({
        restrictions: restrictions.value,
        surface: params.surface,
        productId: params.productId,
        now: params.txNow,
    });
}

// What the member sees of their own standing: that they are restricted, where and until when.
// The staff reason stays with staff.
export function listOwnRestrictions(db: Db, token: BearerToken) {
    return withMember(db, token, (tx, accountId) => readOwnRestrictions(tx, accountId));
}

// Also what the Discord connector's /me shows, so it says what the privacy page says.
export async function readOwnRestrictions(q: Queryable, accountId: AccountId) {
    const rows = await queryAll(
        q,
        RestrictionRow.extend({ id: z.uuid() }),
        sql`select id, kind, product_id as "productId", ends_at as "endsAt"
            from community_restriction
            where account_id = ${accountId} and lifted_at is null
              and (ends_at is null or ends_at > now())
            order by created_at, id`,
    );
    if (!rows.ok) return rows;
    return ok({ restrictions: rows.value });
}
