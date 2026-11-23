import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Forbidden, lockAuthorized, readAsStaff } from "../authority/staff.ts";
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
import { decideReviewOutcome, type ReviewOutcome } from "./review.rules.ts";
import type { Contribution } from "./score.rules.ts";
import { Contributions } from "./scoring.ts";

// The review queue as staff work it. Members never see an item or what contributed to it. Acting
// on an item records the outcome; whatever staff do about the account (a suspension, a word in
// support) is its own audited action. Reading and deciding take accounts:suspend, the action of
// whoever could act on what the queue shows.

const REVIEW_ACTION = "accounts:suspend";

// The queue is short-lived work, not an archive: the newest QUEUE_LIMIT of each state.
const QUEUE_LIMIT = 100;

export type ReviewItem = {
    readonly id: string;
    readonly account: { readonly id: AccountId; readonly username: string | null };
    readonly risk: number;
    readonly urgency: number;
    readonly signals: readonly Contribution[];
    readonly openedAt: EpochMs;
    readonly scoredAt: EpochMs;
    readonly decision: {
        readonly outcome: ReviewOutcome;
        readonly at: EpochMs;
        readonly by: { readonly id: string; readonly username: string | null };
        readonly note: string | null;
    } | null;
};

const ItemRow = z.object({
    id: z.string(),
    account_id: AccountId,
    username: z.string().nullable(),
    risk_score: z.number(),
    urgency_score: z.number(),
    signals: Contributions,
    opened_at: EpochMs,
    scored_at: EpochMs,
    outcome: z.enum(["no_action", "actioned"]).nullable(),
    decided_at: EpochMs.nullable(),
    decided_by: z.string().nullable(),
    decider_username: z.string().nullable(),
    note: z.string().nullable(),
});

function toItem(row: z.output<typeof ItemRow>): ReviewItem {
    return {
        id: row.id,
        account: { id: row.account_id, username: row.username },
        risk: row.risk_score,
        urgency: row.urgency_score,
        signals: row.signals,
        openedAt: row.opened_at,
        scoredAt: row.scored_at,
        decision:
            row.outcome === null || row.decided_at === null || row.decided_by === null
                ? null
                : {
                      outcome: row.outcome,
                      at: row.decided_at,
                      by: { id: row.decided_by, username: row.decider_username },
                      note: row.note,
                  },
    };
}

// Open items most urgent first, then riskiest; decided ones newest first.
export async function listReviewItems(
    db: Db,
    params: { readonly caller: Caller; readonly state: "open" | "decided" },
): Promise<Result<readonly ReviewItem[], Forbidden | DbFailure>> {
    return await readAsStaff(db, { caller: params.caller, actions: [REVIEW_ACTION] }, async (q) => {
        const rows = await queryAll(
            q,
            ItemRow,
            sql`select i.id::text as id, i.account_id, a.username, i.risk_score, i.urgency_score,
                       i.signals, i.opened_at, i.scored_at, i.outcome, i.decided_at, i.decided_by,
                       d.username as decider_username, i.note
                from review_item i
                join account a on a.id = i.account_id
                left join account d on d.id = i.decided_by
                where ${params.state === "open" ? sql`i.decided_at is null` : sql`i.decided_at is not null`}
                order by ${
                    params.state === "open"
                        ? sql`i.urgency_score desc, i.risk_score desc, i.opened_at, i.id`
                        : sql`i.decided_at desc, i.id desc`
                }
                limit ${QUEUE_LIMIT}`,
        );
        if (!rows.ok) return rows;
        return ok(rows.value.map(toItem));
    });
}

export type DecideReviewRefusal = AuthzRefusal | { readonly code: "NOT_FOUND" | "ALREADY_DECIDED" };

export async function decideReviewItem(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly itemId: string;
        readonly outcome: ReviewOutcome;
        readonly note: string | null;
    },
): Promise<Result<void, DecideReviewRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: REVIEW_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const item = await queryOne(
            tx,
            z.object({
                account_id: AccountId,
                risk_score: z.number(),
                urgency_score: z.number(),
                decided_at: EpochMs.nullable(),
            }),
            sql`select account_id, risk_score, urgency_score, decided_at from review_item
                where id = ${params.itemId}::bigint for update`,
        );
        if (!item.ok) return item;
        const allowed = decideReviewOutcome(
            item.value === null ? null : { decidedAt: item.value.decided_at },
        );
        if (!allowed.ok) return allowed;
        invariant(item.value !== null, "an item allowed a decision exists");
        const decided = await execute(
            tx,
            sql`update review_item
                set decided_at = ${toTimestamptz(txNow)}::timestamptz,
                    decided_by = ${params.caller.accountId}, outcome = ${params.outcome},
                    note = ${params.note}
                where id = ${params.itemId}::bigint`,
        );
        if (!decided.ok) return decided;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "review.decide",
            target: {
                accountId: item.value.account_id,
                itemId: params.itemId,
                outcome: params.outcome,
                risk: item.value.risk_score,
                urgency: item.value.urgency_score,
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok(undefined);
    });
}
