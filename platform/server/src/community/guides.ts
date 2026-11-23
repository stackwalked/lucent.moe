import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryAll, queryOne, sql } from "../db/pool.ts";
import { withMember } from "../notify/account.ts";
import { guideReadable } from "./blocks.ts";
import { decideGuideLimit } from "./limits.rules.ts";
import { withMemberAt } from "./member.ts";
import { type NotFound, PAGE_SIZE, pageOf, requireListed } from "./page.ts";
import { mayPostHere } from "./standing.ts";

const Summary = z.object({
    id: z.uuid(),
    title: z.string(),
    username: z.string().nullable(),
    createdAt: EpochMs,
    updatedAt: EpochMs,
});

const toSummary = ({ username, ...row }: z.output<typeof Summary>) => ({
    ...row,
    author: { username },
});

export function listGuides(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly productId: ProductId;
        readonly cursor: string | null;
    },
) {
    return withMember(db, token, async (tx, accountId) => {
        const listed = await requireListed(tx, { accountId, ...params });
        if (!listed.ok) return listed;
        const after =
            params.cursor === null
                ? sql``
                : sql`and (g.created_at, g.id) < (
                      select p.created_at, p.id from guide p
                      where p.id = ${params.cursor}::uuid and p.product_id = ${params.productId}
                        and ${guideReadable(accountId, { removedAt: sql`p.removed_at`, authorId: sql`p.author_id` })})`;
        const rows = await queryAll(
            tx,
            Summary,
            sql`select g.id, g.title, a.username, g.created_at as "createdAt", g.updated_at as "updatedAt"
                from guide g join account a on a.id = g.author_id
                where g.product_id = ${params.productId}
                  and ${guideReadable(accountId, { removedAt: sql`g.removed_at`, authorId: sql`g.author_id` })} ${after}
                order by g.created_at desc, g.id desc limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const page = pageOf(rows.value);
        return ok({ items: page.items.map(toSummary), nextCursor: page.nextCursor });
    });
}

const Detail = Summary.extend({
    productId: ProductId,
    body: z.string(),
    authorId: z.string(),
});

export function readGuide(
    db: Db,
    token: BearerToken,
    params: { readonly catalog: ProductCatalog; readonly id: string },
) {
    return withMember(db, token, async (tx, accountId) => {
        const row = await queryOne(
            tx,
            Detail,
            sql`select g.id, g.title, g.body, g.product_id as "productId", g.author_id as "authorId", a.username,
                       g.created_at as "createdAt", g.updated_at as "updatedAt"
                from guide g join account a on a.id = g.author_id
                where g.id = ${params.id}::uuid
                  and ${guideReadable(accountId, { removedAt: sql`g.removed_at`, authorId: sql`g.author_id` })}`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        const listed = await requireListed(tx, {
            accountId,
            catalog: params.catalog,
            productId: row.value.productId,
        });
        if (!listed.ok) return listed;
        const { authorId, body, productId, ...summary } = row.value;
        return ok({
            ...toSummary(summary),
            productId,
            body,
            isMine: authorId === accountId,
        });
    });
}

export function createGuide(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly productId: ProductId;
        readonly title: string;
        readonly body: string;
    },
) {
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const listed = await requireListed(tx, { accountId, ...params });
        if (!listed.ok) return listed;
        const may = await mayPostHere(tx, {
            accountId,
            surface: "guide",
            productId: params.productId,
            txNow,
        });
        if (!may.ok) return may;
        const held = await queryOne(
            tx,
            z.object({ held: z.coerce.number() }),
            sql`select count(*) as held from guide
                where author_id = ${accountId} and product_id = ${params.productId} and removed_at is null`,
        );
        if (!held.ok) return held;
        const room = decideGuideLimit(held.value?.held ?? 0);
        if (!room.ok) return room;
        const inserted = await queryOne(
            tx,
            z.object({ id: z.uuid() }),
            sql`insert into guide (product_id, author_id, title, body)
                values (${params.productId}, ${accountId}, ${params.title}, ${params.body})
                returning id`,
        );
        if (!inserted.ok) return inserted;
        if (inserted.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        return ok(inserted.value);
    });
}

// Only the author edits, and not what staff removed. The decision is made again for the
// guide's product: a bar set since it was written closes editing too.
export function updateGuide(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly id: string;
        readonly title: string;
        readonly body: string;
    },
) {
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const own = await queryOne(
            tx,
            z.object({ productId: ProductId }),
            sql`select product_id as "productId" from guide
                where id = ${params.id}::uuid and author_id = ${accountId} and removed_at is null
                for update`,
        );
        if (!own.ok) return own;
        if (own.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        const listed = await requireListed(tx, {
            accountId,
            catalog: params.catalog,
            productId: own.value.productId,
        });
        if (!listed.ok) return listed;
        const may = await mayPostHere(tx, {
            accountId,
            surface: "guide",
            productId: own.value.productId,
            txNow,
        });
        if (!may.ok) return may;
        const updated = await execute(
            tx,
            sql`update guide set title = ${params.title}, body = ${params.body}, updated_at = now()
                where id = ${params.id}::uuid`,
        );
        if (!updated.ok) return updated;
        return ok(undefined);
    });
}
