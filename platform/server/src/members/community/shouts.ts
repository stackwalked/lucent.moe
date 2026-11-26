import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { authorize, type Caller, can } from "@lucent/policy/policy";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    execute,
    queryAll,
    queryOne,
    type SqlFragment,
    sql,
    type Tx,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { filterListedProducts, type MemberCatalog } from "../../delivery/products/visibility.ts";
import { lockCallerWith, readStanding } from "../../identity/authority/standing.ts";
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
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const standing = await readStanding(tx, accountId, txNow);
        if (!standing.ok) return standing;
        // Whether the control shows: the author, or staff holding moderation:remove. Deleting
        // decides again under lock (deleteShout); a step-up is not asked for this action.
        const staff =
            standing.value !== null &&
            can({ ...standing.value, stepUpAt: null }, "moderation:remove");
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
                canDelete: staff || authorId === accountId,
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

// The author removes their own shout at any age; staff holding `moderation:remove` remove anyone's,
// and that is audited. Anyone else is told it is not there. Lock order: the caller's account,
// then the shout, then the audit line last. A shout already removed stays as it is, by whoever
// removed it.
export function deleteShout(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly id: string;
}) {
    return withTx(params.db, async (tx, txNow) => {
        const found = await queryOne(
            tx,
            z.object({ authorId: z.string() }),
            sql`select author_id as "authorId" from shout where id = ${params.id}::uuid`,
        );
        if (!found.ok) return found;
        if (found.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        const own = found.value.authorId === params.caller.accountId;
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [],
            txNow,
        });
        if (!locked.ok) {
            if (locked.error.code === "FORBIDDEN") return err<NotFound>({ code: "NOT_FOUND" });
            return err(locked.error);
        }
        if (!own) {
            const authz = authorize({
                txNow,
                subject: locked.value.subject,
                action: "moderation:remove",
            });
            if (!authz.ok) {
                if (authz.error.code === "FORBIDDEN") return err<NotFound>({ code: "NOT_FOUND" });
                return err(authz.error);
            }
        }
        const removed = await queryOne(
            tx,
            z.object({ id: z.uuid() }),
            sql`update shout set removed_at = now(), removed_by = ${params.caller.accountId}
                where id = ${params.id}::uuid and removed_at is null returning id`,
        );
        if (!removed.ok) return removed;
        if (removed.value !== null && !own) {
            const audited = await appendAudit(tx, {
                actorId: params.caller.accountId,
                client: params.caller.client,
                operation: "shout.remove",
                target: { accountId: found.value.authorId, shoutId: params.id },
                at: txNow,
            });
            if (!audited.ok) return audited;
        }
        return ok(undefined);
    });
}

// Staff with `moderation:remove` remove every shout of one account, or the newest N of the whole
// feed, in one transaction with one audit line carrying the count. The rows are locked in id
// order before they change, so two purges at once never wait on each other in a cycle.
export function purgeShouts(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly target: { readonly username: string } | { readonly last: number };
}) {
    return withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, { caller: params.caller, targets: [], txNow });
        if (!locked.ok) return locked;
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "moderation:remove",
        });
        if (!authz.ok) return authz;
        let which: SqlFragment;
        let detail: Record<string, unknown>;
        if ("username" in params.target) {
            const account = await queryOne(
                tx,
                z.object({ id: z.string() }),
                sql`select id from account where username = ${params.target.username.toLowerCase()}`,
            );
            if (!account.ok) return account;
            if (account.value === null) return err<NotFound>({ code: "NOT_FOUND" });
            which = sql`author_id = ${account.value.id} and removed_at is null`;
            detail = {
                accountId: account.value.id,
                username: params.target.username.toLowerCase(),
            };
        } else {
            which = sql`id in (select id from shout where removed_at is null
                               order by created_at desc, id desc limit ${params.target.last})`;
            detail = { accountId: null, last: params.target.last };
        }
        const rows = await queryAll(
            tx,
            z.object({ id: z.uuid() }),
            sql`select id from shout where ${which} order by id for update`,
        );
        if (!rows.ok) return rows;
        const ids = rows.value.map((row) => row.id);
        const removed = await execute(
            tx,
            sql`update shout set removed_at = now(), removed_by = ${params.caller.accountId}
                where id = any(${ids}::uuid[]) and removed_at is null`,
        );
        if (!removed.ok) return removed;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "shout.purge",
            target: { ...detail, removed: removed.value },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ removed: removed.value });
    });
}
