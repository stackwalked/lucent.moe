import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { AccountId, type BearerToken, ProductId } from "@lucent/core/scalars";
import { InboxEntry, type Notice } from "@lucent/rpc/web/inbox";
import { z } from "zod";
import { type Db, execute, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import {
    filterListedProducts,
    isListedForMember,
    type MemberCatalog,
} from "../products/visibility.ts";
import { withMember, written } from "./account.ts";
import { decideDeliveries } from "./deliveries.rules.ts";
import { findProductPreference } from "./preferences.ts";

type Notification =
    | Extract<Notice, { kind: "security" }>
    | (Extract<Notice, { kind: "product_status" }> & {
          readonly catalog: ProductCatalog;
      });

async function planDelivery(tx: Tx, recipient: AccountId, notice: Notification) {
    if (notice.kind === "security") return decideDeliveries(notice, null, []);
    const recipientRow = await queryOne(
        tx,
        z.object({ id: AccountId }),
        sql`select id from account where id = ${recipient} for update`,
    );
    if (!recipientRow.ok) return recipientRow;
    if (recipientRow.value === null) return decideDeliveries(notice, null, []);
    const listed = await isListedForMember(
        tx,
        { accountId: recipient, catalog: notice.catalog },
        notice.productId,
    );
    if (!listed.ok) return listed;
    if (!listed.value) return decideDeliveries(notice, null, []);
    const preference = await findProductPreference(tx, recipient);
    if (!preference.ok) return preference;
    const followed = await queryOne(
        tx,
        z.object({ product_id: ProductId }),
        sql`select product_id from product_subscription where account_id = ${recipient} and product_id = ${notice.productId}`,
    );
    if (!followed.ok) return followed;
    return decideDeliveries(
        notice,
        preference.value,
        followed.value === null ? [] : [followed.value.product_id],
    );
}

// Writers holding later locks must lock recipient accounts first, in canonical order. The
// inbox insert and any future mail enqueue belong to the event's transaction.
export async function recordNotification(tx: Tx, recipient: AccountId, notice: Notification) {
    const plan = await planDelivery(tx, recipient, notice);
    if (!plan.ok || !plan.value.inbox) return plan;
    const inserted = await execute(
        tx,
        sql`insert into inbox_entry (account_id, kind, product_id)
            values (${recipient}, ${notice.kind}, ${notice.productId})`,
    );
    return inserted.ok ? plan : inserted;
}

const PAGE_SIZE = 25;

// Old notices do not turn yesterday's visibility into a permanent product directory. Scope
// cursor resolution, pagination, counts and read receipts to the same visible rows.
async function inboxScope(tx: Tx, member: MemberCatalog) {
    const rows = await queryAll(
        tx,
        z.object({ product_id: ProductId }),
        sql`select distinct product_id from inbox_entry where account_id = ${member.accountId} and product_id is not null`,
    );
    if (!rows.ok) return rows;
    const listed = await filterListedProducts(
        tx,
        member,
        rows.value.map((row) => row.product_id),
    );
    if (!listed.ok) return listed;
    return ok(
        sql`account_id = ${member.accountId} and (product_id is null or product_id = any(${listed.value}::text[]))`,
    );
}

export function listInbox(
    db: Db,
    token: BearerToken,
    params: { readonly cursor: string | null; readonly catalog: ProductCatalog },
) {
    return withMember(db, token, async (tx, id) => {
        const scope = await inboxScope(tx, { accountId: id, catalog: params.catalog });
        if (!scope.ok) return scope;
        const after =
            params.cursor === null
                ? sql``
                : sql`and (created_at, id) < (
            select created_at, id from inbox_entry where ${scope.value} and id = ${params.cursor}::uuid)`;
        const rows = await queryAll(
            tx,
            InboxEntry,
            sql`select id, kind, product_id as "productId", created_at as "createdAt", is_read as "isRead"
                from inbox_entry where ${scope.value} ${after}
                order by created_at desc, id desc limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const items = rows.value.slice(0, PAGE_SIZE);
        return ok({
            items,
            nextCursor: rows.value.length > PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
        });
    });
}

export function countUnread(db: Db, token: BearerToken, catalog: ProductCatalog) {
    return withMember(db, token, async (tx, id) => {
        const scope = await inboxScope(tx, { accountId: id, catalog });
        if (!scope.ok) return scope;
        const count = await queryOne(
            tx,
            z.object({ count: z.coerce.number().int().nonnegative() }),
            sql`select count(*) as count from inbox_entry where ${scope.value} and not is_read`,
        );
        if (!count.ok) return count;
        invariant(count.value !== null, "count always returns a row");
        return ok(count.value);
    });
}

export function markRead(
    db: Db,
    token: BearerToken,
    params: { readonly entryId: string; readonly catalog: ProductCatalog },
) {
    return withMember(db, token, async (tx, id) => {
        const scope = await inboxScope(tx, { accountId: id, catalog: params.catalog });
        if (!scope.ok) return scope;
        return written(
            await execute(
                tx,
                sql`update inbox_entry set is_read = true
            where ${scope.value} and id = ${params.entryId}::uuid and not is_read`,
            ),
        );
    });
}
