import { ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    execute,
    queryOne,
    type SqlFragment,
    sql,
    toTimestamptz,
} from "../db/pool.ts";
import { decideRetentionCutoff, type RetentionTier } from "./retention.rules.ts";
import type { Job } from "./runner.ts";

// Which rows sit in which retention tier, and the one job that enforces it every ten minutes.
// A row in a forever tier is listed so that the table says so; nothing deletes it. Tables owned by
// other areas join this list when they have something to forget.

type Retained = {
    readonly what: string;
    readonly tier: RetentionTier;
    // One batch of the rows older than the cutoff (an ISO timestamp), at most BATCH of them.
    readonly sweep?: (cutoff: string) => SqlFragment;
};

const BATCH = 5_000;

export const RETENTION: readonly Retained[] = [
    // Every renewal's raw answers and signal bits. What they showed lives on as risk_signal rows.
    {
        what: "lease_renewal",
        tier: "90d",
        sweep: (cutoff) =>
            sql`delete from lease_renewal where ctid = any(array(
                    select ctid from lease_renewal where received_at < ${cutoff}::timestamptz
                    limit ${BATCH}))`,
    },
    {
        what: "risk_signal",
        tier: "365d",
        sweep: (cutoff) =>
            sql`delete from risk_signal where id = any(array(
                    select id from risk_signal where observed_at < ${cutoff}::timestamptz
                    limit ${BATCH}))`,
    },
    // Modules' health events and crash summaries (wishlist/protection.md: health events a month).
    {
        what: "module_report",
        tier: "30d",
        sweep: (cutoff) =>
            sql`delete from module_report where id = any(array(
                    select id from module_report where received_at < ${cutoff}::timestamptz
                    limit ${BATCH}))`,
    },
    // Review evidence, counted from the decision; an open item stays however old.
    {
        what: "review_item, decided",
        tier: "365d",
        sweep: (cutoff) =>
            sql`delete from review_item where id = any(array(
                    select id from review_item where decided_at < ${cutoff}::timestamptz
                    limit ${BATCH}))`,
    },
    // A settled row holds no address or text; it stays so staff can reconcile it with the audit
    // entry a dead one wrote. Dead rows are kept longer: someone has to notice them.
    {
        what: "mail_outbox, accepted",
        tier: "30d",
        sweep: (cutoff) =>
            sql`delete from mail_outbox where id = any(array(
                    select id from mail_outbox where state = 'accepted'
                    and finished_at < ${cutoff}::timestamptz limit ${BATCH}))`,
    },
    {
        what: "mail_outbox, dead",
        tier: "90d",
        sweep: (cutoff) =>
            sql`delete from mail_outbox where id = any(array(
                    select id from mail_outbox where state = 'dead'
                    and finished_at < ${cutoff}::timestamptz limit ${BATCH}))`,
    },
    // Mail nothing drained: queued before a provider was removed, or before mail without a
    // provider stopped being queued. A running drain settles a row within hours, so only
    // stranded rows get this old; they hold an address and text, and go.
    {
        what: "mail_outbox, unsent",
        tier: "30d",
        sweep: (cutoff) =>
            sql`delete from mail_outbox where id = any(array(
                    select id from mail_outbox where state in ('pending', 'sending')
                    and due_at < ${cutoff}::timestamptz limit ${BATCH}))`,
    },
    // The connector prunes these as it reads them. With the connector gone for good nothing
    // would, and a DM this old is no longer news.
    {
        what: "connector_discord_dm",
        tier: "30d",
        sweep: (cutoff) =>
            sql`delete from connector_discord_dm where id = any(array(
                    select id from connector_discord_dm
                    where created_at < ${cutoff}::timestamptz limit ${BATCH}))`,
    },
    { what: "audit", tier: "forever" },
    { what: "fact_set, current_fact_set, release, current_release", tier: "forever" },
    { what: "fact_override, fact_override_revision", tier: "forever" },
    { what: "module_build_seen", tier: "forever" },
];

// How many rows went. Each batch is its own statement over one table, holding no other lock.
export async function sweepRetention(db: Db): Promise<Result<number, DbFailure>> {
    const now = await queryOne(db, z.object({ now: EpochMs }), sql`select now() as now`);
    if (!now.ok) return now;
    if (now.value === null) return ok(0);
    let removed = 0;
    for (const entry of RETENTION) {
        const cutoff = decideRetentionCutoff(entry.tier, now.value.now);
        if (!cutoff.ok) return cutoff;
        if (entry.sweep === undefined || cutoff.value === null) continue;
        const at = toTimestamptz(cutoff.value);
        for (;;) {
            const swept = await execute(db, entry.sweep(at));
            if (!swept.ok) return swept;
            removed += swept.value;
            if (swept.value < BATCH) break;
        }
    }
    return ok(removed);
}

export function retentionJob(db: Db): Job {
    return {
        name: "retention",
        everyMs: 10 * 60 * 1_000,
        run: async () => {
            const swept = await sweepRetention(db);
            if (!swept.ok) return swept;
            return ok(swept.value === 0 ? null : `removed ${swept.value} rows past retention`);
        },
    };
}
