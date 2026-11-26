import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { AccountId, type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { authorize, type Caller } from "@lucent/policy/policy";
import { ReportKind, type ReportReason } from "@lucent/rpc/web/moderation";
import { z } from "zod";
import { lockCallerWith } from "../authority/standing.ts";
import { clearRemovedAvatar } from "../community/avatars.ts";
import { guideReadable, notBlockedWith } from "../community/blocks.ts";
import { decideReportLimit } from "../community/limits.rules.ts";
import { type NotFound, requireListed } from "../community/page.ts";
import { appendAudit } from "../db/audit.ts";
import {
    type Db,
    execute,
    queryAll,
    queryOne,
    type SqlFragment,
    sql,
    type Tx,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { withMember } from "../notify/account.ts";
import { QUEUE_PAGE_SIZE, readAsStaff } from "./staff.ts";

type Kind = z.output<typeof ReportKind>;

const Target = z.object({
    authorId: AccountId,
    productId: ProductId.nullable(),
    excerpt: z.string(),
});

// What a report points at, while it is still there: removed content and a comment whose guide
// was removed are gone for everyone, reports included. With a viewer the answer is also what
// that member may read, by the same predicates the lists use (guideReadable, blocks, a private
// profile); without one (staff) it is only what exists. The row is share-locked, so an account
// deletion stripping it (deletion/strip.ts) either waits for this report and closes it, or has
// already taken the row and this finds nothing.
function findTarget(tx: Tx, kind: Kind, id: string, viewer: AccountId | null) {
    const unblocked = (author: SqlFragment) =>
        viewer === null ? sql`true` : notBlockedWith(viewer, author);
    switch (kind) {
        case "comment":
            return queryOne(
                tx,
                Target,
                sql`select c.author_id as "authorId", g.product_id as "productId", left(c.body, 280) as excerpt
                    from comment c join guide g on g.id = c.guide_id
                    where c.id = ${id}::uuid and c.removed_at is null
                      and ${unblocked(sql`c.author_id`)}
                      and ${
                          viewer === null
                              ? sql`g.removed_at is null`
                              : guideReadable(viewer, {
                                    removedAt: sql`g.removed_at`,
                                    authorId: sql`g.author_id`,
                                })
                      }
                    for share of c`,
            );
        case "shout":
            return queryOne(
                tx,
                Target,
                sql`select s.author_id as "authorId", s.product_id as "productId", left(s.body, 280) as excerpt
                    from shout s where s.id = ${id}::uuid and s.removed_at is null
                      and ${unblocked(sql`s.author_id`)}
                    for share`,
            );
        case "guide":
            return queryOne(
                tx,
                Target,
                sql`select g.author_id as "authorId", g.product_id as "productId", left(g.title, 280) as excerpt
                    from guide g where g.id = ${id}::uuid and g.removed_at is null
                      and ${unblocked(sql`g.author_id`)}
                    for share`,
            );
        case "profile":
            return queryOne(
                tx,
                Target,
                sql`select p.account_id as "authorId", null as "productId", left(p.bio, 280) as excerpt
                    from profile p where p.id = ${id}::uuid and p.removed_at is null
                      and (p.bio <> '' or p.avatar_large is not null)
                      and ${unblocked(sql`p.account_id`)}
                      and (${viewer}::text is null or p.account_id = ${viewer} or p.visibility = 'members')
                    for share`,
            );
    }
}

// Any member may flag what they can see, once per thing. A second flag by the same member is the
// same answer, not an error. At most MAX_OPEN_REPORTS of a member's are open at a time.
export function createReport(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly kind: Kind;
        readonly targetId: string;
        readonly reason: z.output<typeof ReportReason>;
        readonly note: string;
    },
) {
    return withMember(db, token, async (tx, accountId) => {
        const target = await findTarget(tx, params.kind, params.targetId, accountId);
        if (!target.ok) return target;
        if (target.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        if (target.value.productId !== null) {
            const listed = await requireListed(tx, {
                accountId,
                catalog: params.catalog,
                productId: target.value.productId,
            });
            if (!listed.ok) return listed;
        }
        const counted = await queryOne(
            tx,
            z.object({ open: z.coerce.number(), same: z.boolean() }),
            sql`select count(*) filter (where state = 'open') as open,
                       coalesce(bool_or(target_kind = ${params.kind} and target_id = ${params.targetId}::uuid), false) as same
                from report where reporter_id = ${accountId}`,
        );
        if (!counted.ok) return counted;
        if (counted.value?.same !== true) {
            const room = decideReportLimit(counted.value?.open ?? 0);
            if (!room.ok) return room;
        }
        const saved = await execute(
            tx,
            sql`insert into report (reporter_id, target_kind, target_id, reason, note)
                values (${accountId}, ${params.kind}, ${params.targetId}::uuid, ${params.reason}, ${params.note})
                on conflict (reporter_id, target_kind, target_id) do nothing`,
        );
        if (!saved.ok) return saved;
        return ok(undefined);
    });
}
const QueueRow = z.object({
    id: z.uuid(),
    kind: ReportKind,
    targetId: z.uuid(),
    reason: z.enum(["spam", "abuse", "other"]),
    note: z.string(),
    reporterUsername: z.string().nullable(),
    authorId: AccountId,
    authorUsername: z.string().nullable(),
    productId: ProductId.nullable(),
    excerpt: z.string(),
    createdAt: EpochMs,
});

// Oldest first: a queue is worked from the front.
export function listReports(
    db: Db,
    params: { readonly caller: Caller; readonly cursor: string | null },
) {
    return readAsStaff(db, { caller: params.caller, action: "moderation:remove" }, async (tx) => {
        const after =
            params.cursor === null
                ? sql``
                : sql`and (r.created_at, r.id) > (
                      select p.created_at, p.id from report p
                      where p.id = ${params.cursor}::uuid and p.state = 'open')`;
        const rows = await queryAll(
            tx,
            QueueRow,
            sql`select r.id, r.target_kind as kind, r.target_id as "targetId", r.reason, r.note,
                       rep.username as "reporterUsername",
                       coalesce(c.author_id, s.author_id, g.author_id, pr.account_id) as "authorId",
                       au.username as "authorUsername",
                       coalesce(cg.product_id, s.product_id, g.product_id) as "productId",
                       left(coalesce(c.body, s.body, g.title, pr.bio), 280) as excerpt,
                       r.created_at as "createdAt"
                from report r
                join account rep on rep.id = r.reporter_id
                left join comment c on r.target_kind = 'comment' and c.id = r.target_id
                left join guide cg on cg.id = c.guide_id
                left join shout s on r.target_kind = 'shout' and s.id = r.target_id
                left join guide g on r.target_kind = 'guide' and g.id = r.target_id
                left join profile pr on r.target_kind = 'profile' and pr.id = r.target_id
                join account au on au.id = coalesce(c.author_id, s.author_id, g.author_id, pr.account_id)
                where r.state = 'open' ${after}
                order by r.created_at, r.id limit ${QUEUE_PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const items = rows.value.slice(0, QUEUE_PAGE_SIZE).map((row) => ({
            id: row.id,
            kind: row.kind,
            targetId: row.targetId,
            reason: row.reason,
            note: row.note,
            reporter: { username: row.reporterUsername },
            author: { accountId: row.authorId, username: row.authorUsername },
            productId: row.productId,
            excerpt: row.excerpt,
            createdAt: row.createdAt,
        }));
        return ok({
            items,
            nextCursor: rows.value.length > QUEUE_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
        });
    });
}

function hide(tx: Tx, kind: Kind, id: string, by: AccountId) {
    const hidden = z.object({ id: z.uuid() });
    switch (kind) {
        case "comment":
            return queryOne(
                tx,
                hidden,
                sql`update comment set removed_at = now(), removed_by = ${by}
                    where id = ${id}::uuid and removed_at is null returning id`,
            );
        case "shout":
            return queryOne(
                tx,
                hidden,
                sql`update shout set removed_at = now(), removed_by = ${by}
                    where id = ${id}::uuid and removed_at is null returning id`,
            );
        case "profile":
            return queryOne(
                tx,
                hidden,
                sql`update profile set removed_at = now(), removed_by = ${by}
                    where id = ${id}::uuid and removed_at is null returning id`,
            );
        case "guide":
            return queryOne(
                tx,
                hidden,
                sql`update guide set removed_at = now(), removed_by = ${by}
                    where id = ${id}::uuid and removed_at is null returning id`,
            );
    }
}

// Gate: `moderation:remove`, no rank target (content has no rank). Lock order: the caller's
// account, then the content row (a profile's then its avatar_image rows), then report rows; dismissal takes only its own report row, so
// two staff resolving reports on one target never wait on each other in a cycle. The audit line
// is last. A removal returns what the caller writes to the `removed` log once this commits.
export async function resolveReport(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly id: string;
    readonly outcome: "remove" | "dismiss";
}) {
    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, { caller: params.caller, targets: [], txNow });
        if (!locked.ok) return locked;
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "moderation:remove",
        });
        if (!authz.ok) return authz;
        const report = await queryOne(
            tx,
            z.object({
                kind: ReportKind,
                targetId: z.uuid(),
            }),
            sql`select target_kind as kind, target_id as "targetId" from report
                where id = ${params.id}::uuid and state = 'open'`,
        );
        if (!report.ok) return report;
        if (report.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        const { kind, targetId } = report.value;
        const target = await findTarget(tx, kind, targetId, null);
        if (!target.ok) return target;
        const authorId = target.value?.authorId ?? null;
        if (params.outcome === "dismiss") {
            const closed = await execute(
                tx,
                sql`update report set state = 'dismissed', resolved_by = ${params.caller.accountId}, resolved_at = now()
                    where id = ${params.id}::uuid and state = 'open'`,
            );
            if (!closed.ok) return closed;
            if (closed.value === 0) return err<NotFound>({ code: "NOT_FOUND" });
            const audited = await appendAudit(tx, {
                actorId: params.caller.accountId,
                client: params.caller.client,
                operation: "community.dismiss_report",
                target: { accountId: authorId, reportId: params.id, kind, targetId },
                at: txNow,
            });
            if (!audited.ok) return audited;
            return ok({ removed: null });
        }
        const hidden = await hide(tx, kind, targetId, params.caller.accountId);
        if (!hidden.ok) return hidden;
        if (kind === "profile" && hidden.value !== null) {
            const pictureGone = await clearRemovedAvatar(tx, targetId);
            if (!pictureGone.ok) return pictureGone;
        }
        const closed = await execute(
            tx,
            sql`update report set state = 'removed', resolved_by = ${params.caller.accountId}, resolved_at = now()
                where target_kind = ${kind} and target_id = ${targetId}::uuid and state = 'open'`,
        );
        if (!closed.ok) return closed;
        if (closed.value === 0) return err<NotFound>({ code: "NOT_FOUND" });
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "community.remove",
            target: { accountId: authorId, reportId: params.id, kind, targetId },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ removed: hidden.value === null ? null : { kind, id: targetId } });
    });
}
