import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, queryAll, queryOne, type SqlFragment, sql, type Tx } from "../../base/db/pool.ts";
import { filterListedProducts, type MemberCatalog } from "../../delivery/products/visibility.ts";
import { withMember } from "../notify/account.ts";
import { authorAvatar } from "./avatars.ts";
import { notBlockedWith } from "./blocks.ts";
import { checkPostRate } from "./limits.ts";
import { withMemberAt } from "./member.ts";
import { type NotFound, PAGE_SIZE, pageOf, requireListed } from "./page.ts";
import { mayPostHere } from "./standing.ts";

const Row = z.object({
    id: z.uuid(),
    username: z.string().nullable(),
    avatar: z.string().nullable(),
    authorId: z.string(),
    productId: ProductId.nullable(),
    body: z.string(),
    createdAt: EpochMs,
});

// The whole feed shows entries about no product and about products the reader may see; a
// product's own feed needs the product itself to be visible.
async function feedScope(tx: Tx, member: MemberCatalog, productId: ProductId | null) {
    if (productId !== null) {
        const listed = await requireListed(tx, { ...member, productId });
        if (!listed.ok) return listed;
        return ok((column: SqlFragment) => sql`${column} = ${productId}`);
    }
    const named = await queryAll(
        tx,
        z.object({ product_id: ProductId }),
        sql`select distinct product_id from shout where product_id is not null and removed_at is null`,
    );
    if (!named.ok) return named;
    const listed = await filterListedProducts(
        tx,
        member,
        named.value.map((row) => row.product_id),
    );
    if (!listed.ok) return listed;
    return ok(
        (column: SqlFragment) =>
            sql`(${column} is null or ${column} = any(${listed.value}::text[]))`,
    );
}

export function listShouts(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly productId: ProductId | null;
        readonly cursor: string | null;
    },
) {
    return withMember(db, token, async (tx, accountId) => {
        const scope = await feedScope(tx, { accountId, catalog: params.catalog }, params.productId);
        if (!scope.ok) return scope;
        const after =
            params.cursor === null
                ? sql``
                : sql`and (s.created_at, s.id) < (
                      select p.created_at, p.id from shout p
                      where p.id = ${params.cursor}::uuid and p.removed_at is null
                        and ${notBlockedWith(accountId, sql`p.author_id`)}
                        and ${scope.value(sql`p.product_id`)})`;
        const rows = await queryAll(
            tx,
            Row,
            sql`select s.id, a.username,
                       ${authorAvatar(accountId, sql`s.author_id`)} as avatar, s.author_id as "authorId", s.product_id as "productId", s.body,
                       s.created_at as "createdAt"
                from shout s join account a on a.id = s.author_id
                where s.removed_at is null and ${notBlockedWith(accountId, sql`s.author_id`)}
                  and ${scope.value(sql`s.product_id`)} ${after}
                order by s.created_at desc, s.id desc limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const page = pageOf(rows.value);
        return ok({
            items: page.items.map(({ username, avatar, authorId, ...row }) => ({
                ...row,
                author: { username, avatar },
                isMine: authorId === accountId,
            })),
            nextCursor: page.nextCursor,
        });
    });
}

export function createShout(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly productId: ProductId | null;
        readonly body: string;
    },
) {
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        if (params.productId !== null) {
            const listed = await requireListed(tx, {
                accountId,
                catalog: params.catalog,
                productId: params.productId,
            });
            if (!listed.ok) return listed;
        }
        const may = await mayPostHere(tx, {
            accountId,
            surface: "shout",
            productId: params.productId,
            txNow,
        });
        if (!may.ok) return may;
        const rate = await checkPostRate(tx, { accountId, txNow });
        if (!rate.ok) return rate;
        const inserted = await queryOne(
            tx,
            z.object({ id: z.uuid() }),
            sql`insert into shout (author_id, product_id, body)
                values (${accountId}, ${params.productId}, ${params.body}) returning id`,
        );
        if (!inserted.ok) return inserted;
        if (inserted.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        return ok(inserted.value);
    });
}
