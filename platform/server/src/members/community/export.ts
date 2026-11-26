import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { type AccountId, type BearerToken, type EpochMs, ProductId } from "@lucent/core/scalars";
import { ExportData } from "@lucent/rpc/web/privacy";
import { z } from "zod";
import { type Db, queryAll, queryOne, sql, type Tx } from "../../base/db/pool.ts";

import { withMemberAt } from "./member.ts";

type Exported = z.output<typeof ExportData>;

// Every statement filters by the caller's own account id; nothing is joined from another
// account except the usernames of those the caller blocked. Read in one transaction, so the file
// is of one moment, and never touches licence, device, credential or support records.
// Each list is the newest EXPORT_CAP rows, oldest first; a list that had more is named in the file.
const EXPORT_CAP = 1_000;

function newest<T>(name: string, rows: readonly T[], cut: string[]): readonly T[] {
    if (rows.length > EXPORT_CAP) cut.push(name);
    return rows.slice(0, EXPORT_CAP).reverse();
}

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
        ExportData.shape.profile.unwrap(),
        sql`
        select bio, visibility, removed_at as "removedAt",
               case when avatar_large is not null
                    then json_build_object('large', avatar_large, 'small', avatar_small)
               end as avatar
        from profile where account_id = ${accountId}`,
    );
    if (!profile.ok) return profile;
    const guides = await queryAll(
        tx,
        ExportData.shape.guides.unwrap().element,
        sql`
        select id, product_id as "productId", title, body, created_at as "createdAt",
               updated_at as "updatedAt", removed_at as "removedAt"
        from guide where author_id = ${accountId} order by created_at desc, id desc limit ${EXPORT_CAP + 1}`,
    );
    if (!guides.ok) return guides;
    const comments = await queryAll(
        tx,
        ExportData.shape.comments.unwrap().element,
        sql`
        select c.id, c.guide_id as "guideId", w.username as "profileUsername", c.body,
               c.created_at as "createdAt", c.removed_at as "removedAt"
        from comment c left join account w on w.id = c.profile_account_id
        where c.author_id = ${accountId} order by c.created_at desc, c.id desc limit ${EXPORT_CAP + 1}`,
    );
    if (!comments.ok) return comments;
    const shouts = await queryAll(
        tx,
        ExportData.shape.shouts.unwrap().element,
        sql`
        select id, product_id as "productId", body, created_at as "createdAt", removed_at as "removedAt"
        from shout where author_id = ${accountId} order by created_at desc, id desc limit ${EXPORT_CAP + 1}`,
    );
    if (!shouts.ok) return shouts;
    const blocks = await queryAll(
        tx,
        ExportData.shape.blocks.unwrap().element,
        sql`
        select a.username, b.created_at as "createdAt"
        from account_block b join account a on a.id = b.blocked_id
        where b.blocker_id = ${accountId} order by b.created_at desc, a.id limit ${EXPORT_CAP + 1}`,
    );
    if (!blocks.ok) return blocks;
    const reportsMade = await queryAll(
        tx,
        ExportData.shape.reportsMade.unwrap().element,
        sql`
        select target_kind as kind, target_id as "targetId", reason, note, state, created_at as "createdAt"
        from report where reporter_id = ${accountId} order by created_at desc, id desc limit ${EXPORT_CAP + 1}`,
    );
    if (!reportsMade.ok) return reportsMade;
    const restrictions = await queryAll(
        tx,
        ExportData.shape.restrictions.unwrap().element,
        sql`
        select kind, product_id as "productId", created_at as "createdAt", ends_at as "endsAt",
               lifted_at as "liftedAt"
        from community_restriction where account_id = ${accountId} order by created_at desc, id desc limit ${EXPORT_CAP + 1}`,
    );
    if (!restrictions.ok) return restrictions;
    const inbox = await queryAll(
        tx,
        ExportData.shape.inbox.unwrap().element,
        sql`
        select kind, product_id as "productId", created_at as "createdAt", is_read as "isRead"
        from inbox_entry where account_id = ${accountId} order by created_at desc, id desc limit ${EXPORT_CAP + 1}`,
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
    const cut: string[] = [];
    const data: Exported = {
        exportedAt: txNow,
        account: account.value,
        truncated: cut,
        profile: profile.value,
        guides: newest("guides", guides.value, cut),
        comments: newest("comments", comments.value, cut),
        shouts: newest("shouts", shouts.value, cut),
        blocks: newest("blocks", blocks.value, cut),
        reportsMade: newest("reportsMade", reportsMade.value, cut),
        restrictions: newest("restrictions", restrictions.value, cut),
        inbox: newest("inbox", inbox.value, cut),
        notificationPreferences: preferences.value,
        subscriptions: subscriptions.value.map((row) => row.productId),
    };
    return ok(data);
}

export function exportOwnData(db: Db, token: BearerToken) {
    return withMemberAt(db, token, (tx, accountId, txNow) => gather(tx, accountId, txNow));
}
