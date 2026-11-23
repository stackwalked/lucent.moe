import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import { withMember } from "../notify/account.ts";
import { withMemberAt } from "./member.ts";
import { type NotFound, PAGE_SIZE, pageOf, requireListed } from "./page.ts";
import { mayPostHere } from "./standing.ts";

// A comment has no product of its own: it takes its guide's, and a guide that is gone, removed
// or unlisted for the reader takes its comments with it.
async function guideProduct(
    tx: Tx,
    params: {
        readonly accountId: Parameters<typeof requireListed>[1]["accountId"];
        readonly catalog: ProductCatalog;
        readonly guideId: string;
    },
) {
    const guide = await queryOne(
        tx,
        z.object({ productId: ProductId }),
        sql`select product_id as "productId" from guide
            where id = ${params.guideId}::uuid and removed_at is null`,
    );
    if (!guide.ok) return guide;
    if (guide.value === null) return err<NotFound>({ code: "NOT_FOUND" });
    const listed = await requireListed(tx, {
        accountId: params.accountId,
        catalog: params.catalog,
        productId: guide.value.productId,
    });
    if (!listed.ok) return listed;
    return ok(guide.value.productId);
}

const Row = z.object({
    id: z.uuid(),
    username: z.string().nullable(),
    authorId: z.string(),
    body: z.string(),
    createdAt: EpochMs,
});

export function listComments(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly guideId: string;
        readonly cursor: string | null;
    },
) {
    return withMember(db, token, async (tx, accountId) => {
        const product = await guideProduct(tx, { accountId, ...params });
        if (!product.ok) return product;
        const after =
            params.cursor === null
                ? sql``
                : sql`and (c.created_at, c.id) > (select created_at, id from comment where id = ${params.cursor}::uuid)`;
        const rows = await queryAll(
            tx,
            Row,
            sql`select c.id, a.username, c.author_id as "authorId", c.body, c.created_at as "createdAt"
                from comment c join account a on a.id = c.author_id
                where c.guide_id = ${params.guideId}::uuid and c.removed_at is null ${after}
                order by c.created_at, c.id limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const page = pageOf(rows.value);
        return ok({
            items: page.items.map(({ username, authorId, ...row }) => ({
                ...row,
                author: { username },
                isMine: authorId === accountId,
            })),
            nextCursor: page.nextCursor,
        });
    });
}

export function createComment(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly guideId: string;
        readonly body: string;
    },
) {
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const product = await guideProduct(tx, { accountId, ...params });
        if (!product.ok) return product;
        const may = await mayPostHere(tx, {
            accountId,
            surface: "comment",
            productId: product.value,
            txNow,
        });
        if (!may.ok) return may;
        const inserted = await queryOne(
            tx,
            z.object({ id: z.uuid() }),
            sql`insert into comment (guide_id, author_id, body)
                values (${params.guideId}::uuid, ${accountId}, ${params.body}) returning id`,
        );
        if (!inserted.ok) return inserted;
        if (inserted.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        return ok(inserted.value);
    });
}
