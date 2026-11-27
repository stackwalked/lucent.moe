import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import type { Logger } from "../../base/core/log.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    type SqlFragment,
    sql,
    toTimestamptz,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import type { Job } from "../../base/jobs/runner.ts";
import { recordNotification } from "./inbox.ts";
import { decideEndingNotice, ENDING_WINDOW_MS } from "./subscription-ending.rules.ts";

const PER_RUN = 200;

// A product of entitlement `id` that no other active entitlement of the account carries past
// `endsAt` without a gap: renewing early means the subscription does not end.
function uncovered(params: {
    readonly id: SqlFragment;
    readonly accountId: SqlFragment;
    readonly endsAt: SqlFragment;
}): SqlFragment {
    const { id, accountId, endsAt } = params;
    return sql`not exists (
        select 1 from entitlement o
        join entitlement_product op on op.entitlement_id = o.id
        where o.account_id = ${accountId} and o.id <> ${id} and o.status = 'active'
          and op.product_id = ep.product_id
          and o.valid_from <= ${endsAt}
          and (o.valid_until is null or o.valid_until > ${endsAt}))`;
}

const Candidate = z.object({ id: z.string(), accountId: AccountId });
const MarkRow = z.object({ mark: z.enum(["7d", "1d"]) });

// One entitlement of one holder, under their locks: the account (an active one, not a tombstone),
// then the entitlement (still active, still ending, its end read after the wait). Everything it
// decides is read here, so a run that waited behind another sees what that one recorded.
async function tellOne(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly id: string;
        readonly accountId: AccountId;
    },
): Promise<Result<number, DbFailure>> {
    return await withTx(db, async (tx) => {
        const account = await queryOne(
            tx,
            z.object({ id: AccountId }),
            sql`select id from account
                where id = ${params.accountId} and status = 'active' and deleted_at is null
                for update`,
        );
        if (!account.ok) return account;
        if (account.value === null) return ok(0);
        const entitlement = await queryOne(
            tx,
            z.object({ validUntil: EpochMs }),
            sql`select valid_until as "validUntil" from entitlement
                where id = ${params.id} and account_id = ${params.accountId}
                  and status = 'active' and valid_until is not null
                  and valid_from <= clock_timestamp()
                for update`,
        );
        if (!entitlement.ok) return entitlement;
        if (entitlement.value === null) return ok(0);
        const { validUntil } = entitlement.value;
        // Read after the locks, in a statement of its own: a renewal that committed while this
        // waited is seen.
        const open = await queryAll(
            tx,
            z.object({ productId: ProductId }),
            sql`select ep.product_id as "productId" from entitlement_product ep
                where ep.entitlement_id = ${params.id}
                  and ${uncovered({
                      id: sql`${params.id}`,
                      accountId: sql`${params.accountId}`,
                      endsAt: sql`${toTimestamptz(validUntil)}::timestamptz`,
                  })}
                order by ep.product_id`,
        );
        if (!open.ok) return open;
        if (open.value.length === 0) return ok(0);
        const clock = await queryOne(
            tx,
            z.object({ now: EpochMs }),
            sql`select clock_timestamp() as now`,
        );
        if (!clock.ok) return clock;
        if (clock.value === null) return ok(0);
        const sent = await queryAll(
            tx,
            MarkRow,
            sql`select mark from subscription_ending_notice
                where entitlement_id = ${params.id}
                  and valid_until = ${toTimestamptz(validUntil)}::timestamptz`,
        );
        if (!sent.ok) return sent;
        const plan = decideEndingNotice({
            now: clock.value.now,
            validUntil,
            sent: sent.value.map((row) => row.mark),
        }).value;
        if (plan.record.length === 0) return ok(0);
        for (const mark of plan.record) {
            const recorded = await execute(
                tx,
                sql`insert into subscription_ending_notice (entitlement_id, valid_until, mark)
                    values (${params.id}, ${toTimestamptz(validUntil)}::timestamptz, ${mark})
                    on conflict do nothing`,
            );
            if (!recorded.ok) return recorded;
        }
        if (plan.file === null) return ok(0);
        for (const { productId } of open.value) {
            const told = await recordNotification(tx, {
                recipient: params.accountId,
                notice: {
                    kind: "subscription_ending",
                    productId,
                    endsAt: validUntil,
                    catalog: params.catalog,
                },
            });
            if (!told.ok) return told;
        }
        return ok(open.value.length);
    });
}

// Tells holders their entitlement is about to end: once per entitlement at each mark of
// subscription-ending.rules.ts, however often this runs and however many instances run it (the
// marks recorded under the holder's lock are the memory). Not entitlements without an end,
// suspended or revoked ones, nor suspended or deleted accounts, nor a product the holder keeps
// through another entitlement. Soonest end first, so a large first run does not make tomorrow's
// wait behind next week's. One entitlement failing is logged and the rest go on; `failed` counts
// them.
export async function tellEndingSubscriptions(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly logger: Logger },
): Promise<Result<{ readonly told: number; readonly failed: number }, DbFailure>> {
    const candidates = await queryAll(
        db,
        Candidate,
        sql`select e.id, e.account_id as "accountId" from entitlement e
            join account a on a.id = e.account_id
            where e.status = 'active' and e.valid_until is not null
              and e.valid_from <= now()
              and e.valid_until > now()
              and e.valid_until <= now() + ${ENDING_WINDOW_MS / 1_000} * interval '1 second'
              and a.status = 'active' and a.deleted_at is null
              -- Not one already told its latest mark: a backlog of those must not fill the batch.
              and not exists (select 1 from subscription_ending_notice n
                              where n.entitlement_id = e.id and n.valid_until = e.valid_until
                                and n.mark = case when e.valid_until <= now() + interval '1 day'
                                                  then '1d' else '7d' end)
              -- Nor one whose every product the holder keeps by another entitlement.
              and exists (select 1 from entitlement_product ep
                          where ep.entitlement_id = e.id
                            and ${uncovered({ id: sql`e.id`, accountId: sql`e.account_id`, endsAt: sql`e.valid_until` })})
            order by e.valid_until, e.id limit ${PER_RUN}`,
    );
    if (!candidates.ok) return candidates;
    let told = 0;
    let failed = 0;
    for (const candidate of candidates.value) {
        const done = await tellOne(db, { catalog: params.catalog, ...candidate });
        if (!done.ok) {
            failed += 1;
            params.logger.write("error", "subscription ending notice failed", {
                origin: "jobs",
                detail: `entitlement ${candidate.id}: ${done.error.code}`,
            });
            continue;
        }
        told += done.value;
    }
    return ok({ told, failed });
}

export function subscriptionEndingJob(params: {
    readonly db: Db;
    readonly catalog: ProductCatalog;
    readonly logger: Logger;
}): Job {
    return {
        name: "subscription-ending",
        everyMs: 15 * 60 * 1_000,
        run: async () => {
            const run = await tellEndingSubscriptions(params.db, params);
            if (!run.ok) return run;
            // Shown to staff on the jobs page as the run's failure; the rows are in the log.
            if (run.value.failed > 0) return err({ code: "ENTITLEMENT_NOTICE_FAILED" });
            return ok(
                run.value.told === 0 ? null : `told ${run.value.told} of a subscription ending`,
            );
        },
    };
}
