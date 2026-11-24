import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { type BearerToken, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { lockSession, readSession } from "../auth/sessions.ts";
import { type Db, execute, queryOne, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { findSuspension } from "./suspension.ts";
import { decideTicket } from "./tickets.rules.ts";
import { applyTicketEvent, lockTicket, readThread } from "./tickets.ts";

// A suspended account's appeal, reached only with an appeal session: one thread per account,
// answered by staff as any ticket is. Reinstating the account is staff's own audited action on
// the account page; the appeal records what was said.

const AppealRow = z.object({
    id: z.string(),
    state: z.enum(["open", "answered", "closed"]),
    openedAt: EpochMs,
});

export function readAppeal(db: Db, token: BearerToken) {
    return withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, { token, txNow, purposes: ["appeal"] });
        if (!session.ok) return session;
        const { accountId } = session.value;
        const suspension = await findSuspension(tx, accountId);
        if (!suspension.ok) return suspension;
        const appeal = await queryOne(
            tx,
            AppealRow,
            sql`select id::text as id, state, opened_at as "openedAt" from ticket
                where account_id = ${accountId} and kind = 'appeal'`,
        );
        if (!appeal.ok) return appeal;
        if (appeal.value === null) return ok({ suspension: suspension.value, appeal: null });
        const thread = await readThread(tx, appeal.value.id);
        if (!thread.ok) return thread;
        return ok({
            suspension: suspension.value,
            appeal: {
                ...appeal.value,
                messages: thread.value.map((message) => ({
                    id: message.id,
                    fromStaff: message.fromStaff,
                    body: message.body,
                    at: message.at,
                })),
            },
        });
    });
}

// The first message files the appeal; later ones add to it, reopening it if staff closed it.
export function writeAppeal(db: Db, token: BearerToken, params: { readonly body: string }) {
    return withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, { token, txNow, purposes: ["appeal"] });
        if (!session.ok) return session;
        const { accountId } = session.value;
        const existing = await queryOne(
            tx,
            z.object({ id: z.string() }),
            sql`select id::text as id from ticket
                where account_id = ${accountId} and kind = 'appeal'`,
        );
        if (!existing.ok) return existing;
        if (existing.value === null) {
            const filed = await queryOne(
                tx,
                z.object({ id: z.string() }),
                sql`insert into ticket (account_id, kind, state, opened_at, last_activity_at)
                    values (${accountId}, 'appeal', 'open', now(), now())
                    returning id::text as id`,
            );
            if (!filed.ok) return filed;
            invariant(filed.value !== null, "an insert returns its row");
            const written = await execute(
                tx,
                sql`insert into ticket_message (ticket_id, author_id, from_staff, body, created_at)
                    values (${filed.value.id}::uuid, ${accountId}, false, ${params.body}, now())`,
            );
            if (!written.ok) return written;
            return ok(undefined);
        }
        const ticketId = existing.value.id;
        const ticket = await lockTicket(tx, ticketId);
        if (!ticket.ok) return ticket;
        const plan = decideTicket({
            ticket:
                ticket.value === null
                    ? null
                    : {
                          accountId: ticket.value.account_id,
                          state: ticket.value.state,
                          messages: ticket.value.messages,
                      },
            actorId: accountId,
            event: "member_wrote",
        });
        if (!plan.ok) return plan;
        return await applyTicketEvent(tx, {
            ticketId,
            authorId: accountId,
            fromStaff: false,
            body: params.body,
            plan: plan.value,
            txNow,
        });
    });
}
