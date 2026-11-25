import type { Clock } from "@lucent/core/clock";
import { ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type Envelope,
    MAIL_TIMEOUT_MS,
    type MailOutcome,
    type MailTransport,
} from "../adapters/mail/mail.ts";
import { appendAudit } from "../db/audit.ts";
import { type Db, execute, queryOne, sql, type Tx, toTimestamptz } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import type { Job } from "../jobs/runner.ts";
import { decideMailClaim, decideMailRetry } from "./mail.rules.ts";

const Due = z.object({
    id: z.uuid(),
    recipient: z.string(),
    subject: z.string(),
    body: z.string(),
    first_attempt_at: EpochMs.nullable(),
    attempts: z.int().nonnegative(),
    binding: z.string().nullable(),
});
type MailClaim = {
    readonly envelope: Envelope;
    readonly binding: string;
    readonly first: EpochMs;
    readonly stopAt: EpochMs;
    readonly attempt: number;
    readonly leaseUntil: EpochMs;
};
type Worker = {
    readonly db: Db;
    readonly mail: MailTransport;
    // Offline jobs can advance time without sleeps. The running server uses PostgreSQL time.
    readonly clock?: Clock;
};

// Settling clears reset_hash: a settled row no longer depends on its link, so it outlives the
// link for its retention period and staff can still see a dead reset mail (migration 0020).
async function finish(
    tx: Tx,
    params: {
        readonly id: string;
        readonly attempt: number;
        readonly now: EpochMs;
        readonly outcome: "accepted" | "unconfirmed" | "refused";
    },
) {
    const changed = await queryOne(
        tx,
        z.object({ staff_ref: z.uuid() }),
        sql`update mail_outbox
        set state = ${params.outcome === "accepted" ? "accepted" : "dead"}, due_at = null,
            finished_at = ${toTimestamptz(params.now)}::timestamptz, recipient = null, subject = null, body = null,
            reset_hash = null
        where id = ${params.id} and attempts = ${params.attempt} and due_at is not null returning staff_ref`,
    );
    if (!changed.ok) return changed;
    if (changed.value === null || params.outcome === "accepted") return ok(undefined);
    return appendAudit(tx, {
        actorId: "job:mail",
        operation: "mail.delivery_dead",
        at: params.now,
        // A queue reference lets staff reconcile an uncertain provider request without an
        // address, account id, request body or a credential for replaying it.
        target: {
            outcome: params.outcome,
            deliveryId: changed.value.staff_ref,
            attempts: params.attempt,
        },
        client: null,
    });
}

// Claim one row, not a batch that could run out of lease while waiting for earlier sends.
export function claimMail(worker: Worker) {
    return withTx(worker.db, async (tx, txNow) => {
        const now = worker.clock?.now() ?? txNow;
        const due = await queryOne(
            tx,
            Due,
            sql`select id, recipient, subject, body, first_attempt_at, attempts, binding
            from mail_outbox where due_at <= ${toTimestamptz(now)}::timestamptz
            and (reset_hash is null or exists(select from password_reset where token_hash = reset_hash and expires_at > now()))
            order by due_at, id limit 1 for update skip locked`,
        );
        if (!due.ok) return due;
        if (due.value === null) return ok(null);
        const row = due.value;
        const plan = decideMailClaim({
            provider: worker.mail.provider,
            now,
            first: row.first_attempt_at,
            attempts: row.attempts,
            sameBinding: row.binding === null || row.binding === worker.mail.binding,
        });
        if (!plan.ok) {
            const dead = await finish(tx, {
                id: row.id,
                attempt: row.attempts,
                now,
                outcome: "unconfirmed",
            });
            return dead.ok ? ok(null) : dead;
        }
        const { first, attempt, leaseUntil } = plan.value;
        const claimed = await execute(
            tx,
            sql`update mail_outbox set state = 'sending',
            binding = ${worker.mail.binding}, attempts = ${attempt}, first_attempt_at = ${toTimestamptz(first)}::timestamptz,
            due_at = ${toTimestamptz(leaseUntil)}::timestamptz where id = ${row.id}`,
        );
        if (!claimed.ok) return claimed;
        return ok({
            ...plan.value,
            binding: worker.mail.binding,
            envelope: {
                id: row.id,
                recipient: row.recipient,
                subject: row.subject,
                body: row.body,
            },
        });
    });
}

// No Tx crosses this boundary. A delayed worker must not start a request outside its lease or
// the provider's deduplication window, even if its claim used to be valid.
export async function sendClaim(worker: Worker, claim: MailClaim): Promise<MailOutcome> {
    // The database reply can itself be delayed. Bound the whole check-and-send interval.
    const deadline = AbortSignal.timeout(MAIL_TIMEOUT_MS);
    const current = await queryOne(
        worker.db,
        z.object({ now: EpochMs }),
        sql`select now() as now from mail_outbox where id = ${claim.envelope.id} and state = 'sending' and attempts = ${claim.attempt}
            and (reset_hash is null or exists(select from password_reset where token_hash = reset_hash and expires_at > now()))`,
    );
    if (!current.ok || current.value === null || deadline.aborted) return "retry";
    const now = worker.clock?.now() ?? current.value.now;
    if (claim.binding !== worker.mail.binding || now < claim.first || now >= claim.stopAt)
        return "unconfirmed";
    if (now >= claim.leaseUntil) return "retry";
    return await worker.mail.send(claim.envelope, deadline);
}

export function settleMail(worker: Worker, claim: MailClaim, outcome: MailOutcome) {
    return withTx(worker.db, async (tx, txNow) => {
        const now = worker.clock?.now() ?? txNow;
        const params = { id: claim.envelope.id, attempt: claim.attempt, now };
        if (outcome !== "retry")
            return finish(tx, {
                ...params,
                outcome: outcome === "refused" && claim.attempt > 1 ? "unconfirmed" : outcome,
            });
        const retry = decideMailRetry({ ...claim, now });
        if (!retry.ok) return finish(tx, { ...params, outcome: "unconfirmed" });
        const changed = await execute(
            tx,
            sql`update mail_outbox set state = 'pending', due_at = ${toTimestamptz(retry.value)}::timestamptz
            where id = ${params.id} and attempts = ${claim.attempt} and state = 'sending'`,
        );
        return changed.ok ? ok(undefined) : changed;
    });
}

export function mailDeliveryJob(worker: Worker): Job {
    return {
        name: "mail delivery",
        everyMs: 1_000,
        run: async () => {
            const claim = await claimMail(worker);
            if (!claim.ok) return claim;
            if (claim.value === null) return ok(null);
            const outcome = await sendClaim(worker, claim.value);
            const settled = await settleMail(worker, claim.value, outcome);
            return settled.ok ? ok(`${worker.mail.provider}: ${outcome}`) : settled;
        },
    };
}
