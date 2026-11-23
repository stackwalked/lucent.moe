import { ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs, toHex } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import type { Job } from "../jobs/runner.ts";
import {
    decideReviewItem,
    decideRiskScore,
    decideScoringFrom,
    type RiskScore,
} from "./score.rules.ts";

// Every ten minutes, the accounts with signals newer than the cursor are scored again and the
// review queue follows: an item opens, or an open one rises. Each account is its own transaction,
// so one account's failure stalls only the cursor, and a rerun after one scores the same signals
// to the same plan.

const SCORING_EVERY_MS = 10 * 60 * 1_000;

const SignalRow = z.object({
    kind: z.enum(["loader_silent", "software_device_key"]),
    session_id: z.instanceof(Uint8Array).nullable(),
    observed_at: EpochMs,
});

export const Contributions = z.array(
    z.object({
        kind: SignalRow.shape.kind,
        sessions: z.number().int().nonnegative(),
        lastAt: EpochMs,
        weight: z.number(),
    }),
);

function toSignalsJson(score: RiskScore): string {
    return JSON.stringify(score.signals);
}

async function scoreAccount(tx: Tx, accountId: AccountId, txNow: EpochMs) {
    const open = await queryOne(
        tx,
        z.object({
            id: z.string(),
            risk_score: z.number(),
            urgency_score: z.number(),
            signals: Contributions,
        }),
        sql`select id::text as id, risk_score, urgency_score, signals from review_item
            where account_id = ${accountId} and decided_at is null
            for update`,
    );
    if (!open.ok) return open;
    const signals = await queryAll(
        tx,
        SignalRow,
        sql`select kind, session_id, observed_at from risk_signal
            where account_id = ${accountId}
              and observed_at > coalesce(
                  (select max(decided_at) from review_item where account_id = ${accountId}),
                  '-infinity')
            order by id`,
    );
    if (!signals.ok) return signals;
    const score = decideRiskScore(
        signals.value.map((row) => ({
            kind: row.kind,
            sessionId: row.session_id === null ? null : toHex(row.session_id),
            observedAt: row.observed_at,
        })),
        txNow,
    );
    if (!score.ok) return score;
    const plan = decideReviewItem({
        open:
            open.value === null
                ? null
                : {
                      id: open.value.id,
                      risk: open.value.risk_score,
                      urgency: open.value.urgency_score,
                      signals: open.value.signals,
                  },
        score: score.value,
    });
    if (!plan.ok) return plan;
    const at = toTimestamptz(txNow);
    switch (plan.value.kind) {
        case "none":
            return ok(false);
        case "open": {
            const { score: opened } = plan.value;
            const inserted = await execute(
                tx,
                sql`insert into review_item
                        (account_id, risk_score, urgency_score, signals, opened_at, scored_at)
                    values (${accountId}, ${opened.risk}, ${opened.urgency},
                            ${toSignalsJson(opened)}::jsonb, ${at}::timestamptz, ${at}::timestamptz)`,
            );
            if (!inserted.ok) return inserted;
            return ok(true);
        }
        case "raise": {
            const { id, score: raised } = plan.value;
            const updated = await execute(
                tx,
                sql`update review_item
                    set risk_score = ${raised.risk}, urgency_score = ${raised.urgency},
                        signals = ${toSignalsJson(raised)}::jsonb, scored_at = ${at}::timestamptz
                    where id = ${id}::bigint`,
            );
            if (!updated.ok) return updated;
            return ok(true);
        }
    }
}

// How many accounts' items opened or rose.
export async function scoreRisk(db: Db): Promise<Result<number, DbFailure>> {
    const window = await queryOne(
        db,
        z.object({ through: EpochMs.nullable(), now: EpochMs }),
        sql`select case when scored_through = '-infinity' then null else scored_through end
                       as through,
                   now() as now
            from risk_scoring_cursor`,
    );
    if (!window.ok) return window;
    if (window.value === null) return ok(0);
    const { through, now } = window.value;
    const start = decideScoringFrom(through);
    if (!start.ok) return start;
    const from = start.value === null ? null : toTimestamptz(start.value);
    const accounts = await queryAll(
        db,
        z.object({ account_id: AccountId }),
        sql`select distinct account_id from risk_signal
            where observed_at > coalesce(${from}::timestamptz, '-infinity')
            order by account_id`,
    );
    if (!accounts.ok) return accounts;
    let changed = 0;
    for (const { account_id: accountId } of accounts.value) {
        const scored = await withTx(db, (tx, txNow) => scoreAccount(tx, accountId, txNow));
        if (!scored.ok) return scored;
        if (scored.value) changed += 1;
    }
    const moved = await execute(
        db,
        sql`update risk_scoring_cursor set scored_through = ${toTimestamptz(now)}::timestamptz`,
    );
    if (!moved.ok) return moved;
    return ok(changed);
}

export function riskScoringJob(db: Db): Job {
    return {
        name: "risk-scoring",
        everyMs: SCORING_EVERY_MS,
        run: async () => {
            const scored = await scoreRisk(db);
            if (!scored.ok) return scored;
            return ok(scored.value === 0 ? null : `scored ${scored.value} accounts into review`);
        },
    };
}
