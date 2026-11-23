import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs, ProductId } from "@lucent/core/scalars";
import { type AuthzRefusal, authorize, type Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { lockCallerWith } from "../authority/standing.ts";
import {
    decideRestriction,
    RESTRICTION_KINDS,
    type RestrictionKind,
    type RestrictionRefusal,
} from "../community/standing.rules.ts";
import { appendAudit } from "../db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    sql,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import type { Job } from "../jobs/runner.ts";
import { QUEUE_PAGE_SIZE, readAsStaff } from "./staff.ts";

const ACTION = "moderation:remove";

type NotFound = { readonly code: "NOT_FOUND" };

// Gate: the existing `moderation:remove` action, with the target's rank, so staff cannot restrict
// a peer, a superior or root. Gather the locked accounts, decide the terms, then write the row
// and the audit line last.
export async function setRestriction(params: {
    readonly db: Db;
    readonly catalog: ProductCatalog;
    readonly caller: Caller;
    readonly username: string;
    readonly kind: RestrictionKind;
    readonly productId: ProductId | null;
    readonly reason: string;
    readonly endsAt: EpochMs | null;
}): Promise<
    Result<{ readonly id: string }, AuthzRefusal | RestrictionRefusal | NotFound | DbFailure>
> {
    return await withTx(params.db, async (tx, txNow) => {
        const found = await queryOne(
            tx,
            z.object({ id: AccountId }),
            sql`select id from account where username = ${params.username.toLowerCase()}`,
        );
        if (!found.ok) return found;
        if (found.value === null) return err({ code: "NOT_FOUND" as const });
        const targetId = found.value.id;
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [targetId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(targetId);
        if (target === undefined) return err({ code: "NOT_FOUND" as const });
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: ACTION,
            target: { kind: "account", account: target },
        });
        if (!authz.ok) return authz;
        const terms = decideRestriction({
            now: txNow,
            endsAt: params.endsAt,
            productId: params.productId,
            productKnown: params.productId !== null && params.catalog.has(params.productId),
        });
        if (!terms.ok) return terms;
        const endsIso = params.endsAt === null ? null : toTimestamptz(params.endsAt);
        const inserted = await queryOne(
            tx,
            z.object({ id: z.uuid() }),
            sql`insert into community_restriction (account_id, kind, product_id, reason, set_by, ends_at)
                values (${targetId}, ${params.kind}, ${params.productId}, ${params.reason},
                        ${params.caller.accountId}, ${endsIso}::timestamptz)
                returning id`,
        );
        if (!inserted.ok) return inserted;
        if (inserted.value === null) return err({ code: "NOT_FOUND" as const });
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "community.restrict",
            target: {
                accountId: targetId,
                reason: params.reason,
                kind: params.kind,
                productId: params.productId,
                endsAt: params.endsAt,
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ id: inserted.value.id });
    });
}

export async function liftRestriction(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly id: string;
}): Promise<Result<null, AuthzRefusal | NotFound | DbFailure>> {
    return await withTx(params.db, async (tx, txNow) => {
        const seen = await queryOne(
            tx,
            z.object({ accountId: AccountId }),
            sql`select account_id as "accountId" from community_restriction where id = ${params.id}::uuid`,
        );
        if (!seen.ok) return seen;
        if (seen.value === null) return err({ code: "NOT_FOUND" as const });
        const targetId = seen.value.accountId;
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [targetId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(targetId);
        if (target === undefined) return err({ code: "NOT_FOUND" as const });
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: ACTION,
            target: { kind: "account", account: target },
        });
        if (!authz.ok) return authz;
        const lifted = await execute(
            tx,
            sql`update community_restriction set lifted_at = now(), lifted_by = ${params.caller.accountId}
                where id = ${params.id}::uuid and lifted_at is null`,
        );
        if (!lifted.ok) return lifted;
        if (lifted.value === 0) return err({ code: "NOT_FOUND" as const });
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "community.lift",
            target: { accountId: targetId, restrictionId: params.id },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok(null);
    });
}

// The job: tidies what the posting decision already ignores, so the partial indexes stay small.
// It locks no account and writes only restriction rows, so it sits outside the lock order.
export function expireRestrictions(db: Db): Promise<Result<number, DbFailure>> {
    return execute(
        db,
        sql`update community_restriction set lifted_at = ends_at
            where lifted_at is null and ends_at is not null and ends_at <= now()`,
    );
}

// Once a minute, like the other housekeeping: the posting decision never waits on it.
export function restrictionExpiryJob(db: Db): Job {
    return {
        name: "restriction-expiry",
        everyMs: 60_000,
        run: async () => {
            const expired = await expireRestrictions(db);
            if (!expired.ok) return expired;
            return ok(expired.value === 0 ? null : `lifted ${expired.value} expired restrictions`);
        },
    };
}

const ListedRow = z.object({
    id: z.uuid(),
    accountId: AccountId,
    username: z.string().nullable(),
    kind: z.enum(RESTRICTION_KINDS),
    productId: ProductId.nullable(),
    reason: z.string(),
    createdAt: EpochMs,
    endsAt: EpochMs.nullable(),
});

export function listRestrictions(
    db: Db,
    params: { readonly caller: Caller; readonly cursor: string | null },
) {
    return readAsStaff(db, { caller: params.caller, action: ACTION }, async (tx) => {
        const after =
            params.cursor === null
                ? sql``
                : sql`and (r.created_at, r.id) < (
                    select p.created_at, p.id from community_restriction p
                    where p.id = ${params.cursor}::uuid and p.lifted_at is null
                      and (p.ends_at is null or p.ends_at > now()))`;
        const rows = await queryAll(
            tx,
            ListedRow,
            sql`select r.id, r.account_id as "accountId", a.username, r.kind, r.product_id as "productId",
                       r.reason, r.created_at as "createdAt", r.ends_at as "endsAt"
                from community_restriction r join account a on a.id = r.account_id
                where r.lifted_at is null and (r.ends_at is null or r.ends_at > now()) ${after}
                order by r.created_at desc, r.id desc limit ${QUEUE_PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const items = rows.value.slice(0, QUEUE_PAGE_SIZE);
        return ok({
            items,
            nextCursor: rows.value.length > QUEUE_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
        });
    });
}
