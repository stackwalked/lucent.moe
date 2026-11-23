import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { type AccountId, type BearerToken, type EpochMs, ProductId } from "@lucent/core/scalars";
import { ExportData } from "@lucent/rpc/web/privacy";
import { z } from "zod";
import { type Db, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";

import { withMemberAt } from "./member.ts";

type Exported = z.output<typeof ExportData>;

// Every statement filters by the caller's own account id; nothing is joined from another
// account except the usernames of those the caller blocked. Read in one transaction, so the file
// is of one moment, and never touches licence, device, credential or support records.
async function gather(tx: Tx, accountId: AccountId, txNow: EpochMs) {
    const account = await queryOne(
        tx,
        ExportData.shape.account,
        sql`
        select id, email, username, created_at as "createdAt" from account where id = ${accountId}`,
    );
    if (!account.ok) return account;
    const profile = await queryOne(
        tx,
        z.object({ bio: z.string(), visibility: z.enum(["members", "private"]) }),
        sql`
        select bio, visibility from profile where account_id = ${accountId}`,
    );
    if (!profile.ok) return profile;
    const guides = await queryAll(
        tx,
        ExportData.shape.guides.unwrap().element,
        sql`
        select id, product_id as "productId", title, body, created_at as "createdAt",
               updated_at as "updatedAt", removed_at as "removedAt"
        from guide where author_id = ${accountId} order by created_at, id`,
    );
    if (!guides.ok) return guides;
    const comments = await queryAll(
        tx,
        ExportData.shape.comments.unwrap().element,
        sql`
        select id, guide_id as "guideId", body, created_at as "createdAt", removed_at as "removedAt"
        from comment where author_id = ${accountId} order by created_at, id`,
    );
    if (!comments.ok) return comments;
    const shouts = await queryAll(
        tx,
        ExportData.shape.shouts.unwrap().element,
        sql`
        select id, product_id as "productId", body, created_at as "createdAt", removed_at as "removedAt"
        from shout where author_id = ${accountId} order by created_at, id`,
    );
    if (!shouts.ok) return shouts;
    const blocks = await queryAll(
        tx,
        ExportData.shape.blocks.unwrap().element,
        sql`
        select a.username, b.created_at as "createdAt"
        from account_block b join account a on a.id = b.blocked_id
        where b.blocker_id = ${accountId} order by b.created_at, a.id`,
    );
    if (!blocks.ok) return blocks;
    const reportsMade = await queryAll(
        tx,
        ExportData.shape.reportsMade.unwrap().element,
        sql`
        select target_kind as kind, target_id as "targetId", reason, note, state, created_at as "createdAt"
        from report where reporter_id = ${accountId} order by created_at, id`,
    );
    if (!reportsMade.ok) return reportsMade;
    const restrictions = await queryAll(
        tx,
        ExportData.shape.restrictions.unwrap().element,
        sql`
        select kind, product_id as "productId", created_at as "createdAt", ends_at as "endsAt",
               lifted_at as "liftedAt"
        from community_restriction where account_id = ${accountId} order by created_at, id`,
    );
    if (!restrictions.ok) return restrictions;
    const inbox = await queryAll(
        tx,
        ExportData.shape.inbox.unwrap().element,
        sql`
        select kind, product_id as "productId", created_at as "createdAt", is_read as "isRead"
        from inbox_entry where account_id = ${accountId} order by created_at, id`,
    );
    if (!inbox.ok) return inbox;
    const preferences = await queryAll(
        tx,
        ExportData.shape.notificationPreferences.unwrap().element,
        sql`
        select kind, inbox, mail from notification_preference where account_id = ${accountId} order by kind`,
    );
    if (!preferences.ok) return preferences;
    const subscriptions = await queryAll(
        tx,
        z.object({ productId: ProductId }),
        sql`
        select product_id as "productId" from product_subscription where account_id = ${accountId} order by product_id`,
    );
    if (!subscriptions.ok) return subscriptions;
    invariant(account.value !== null, "a live session's account exists");
    const data: Exported = {
        exportedAt: txNow,
        account: account.value,
        profile: profile.value,
        guides: guides.value,
        comments: comments.value,
        shouts: shouts.value,
        blocks: blocks.value,
        reportsMade: reportsMade.value,
        restrictions: restrictions.value,
        inbox: inbox.value,
        notificationPreferences: preferences.value,
        subscriptions: subscriptions.value.map((row) => row.productId),
    };
    return ok(data);
}

export function exportOwnData(db: Db, token: BearerToken) {
    return withMemberAt(db, token, (tx, accountId, txNow) => gather(tx, accountId, txNow));
}
