import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { type AuthzRefusal, authorize, type Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { readAsStaff } from "../authority/staff.ts";
import { lockCallerWith } from "../authority/standing.ts";
import { type NotFound, PAGE_SIZE, pageOf } from "../community/page.ts";
import { appendAudit } from "../db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import type { Job } from "../jobs/runner.ts";
import { withMember } from "../notify/account.ts";
import { recordNotification } from "../notify/inbox.ts";
import { isListedForMember } from "../products/visibility.ts";
import { findSuspension } from "./suspension.ts";
import {
    decideConfigRead,
    decideIdleCutoff,
    decideOpenTicket,
    decideTicket,
    MESSAGES_PER_TICKET,
    type TicketEvent,
    type TicketRefusal,
    type TicketState,
} from "./tickets.rules.ts";

// Tickets as members open and follow them and staff answer them. Staff read and act with
// tickets:reply; members see that staff answered, never which staff account did.

const TICKET_ACTION = "tickets:reply";

const State = z.enum(["open", "answered", "closed"]);
const Kind = z.enum(["help", "appeal"]);

const GatheredRow = z.object({
    account_id: AccountId,
    state: State,
    kind: Kind,
    messages: z.coerce.number().int().nonnegative(),
});

// The ticket row locked for a writer, after the writer's own account (canonical order).
// The messages are counted in a statement of their own: counted with the lock, they would be
// seen as of before the wait for it, and two writers could both pass the cap.
export async function lockTicket(tx: Tx, ticketId: string) {
    const locked = await queryOne(
        tx,
        z.object({ id: z.string() }),
        sql`select id::text as id from ticket where id = ${ticketId}::uuid for update`,
    );
    if (!locked.ok || locked.value === null) return locked.ok ? ok(null) : locked;
    return await queryOne(
        tx,
        GatheredRow,
        sql`select t.account_id, t.state, t.kind,
                   (select count(*) from ticket_message m where m.ticket_id = t.id) as messages
            from ticket t where t.id = ${ticketId}::uuid`,
    );
}

// Applies a decided event: the message if it writes one, then the state and the activity time.
export async function applyTicketEvent(
    tx: Tx,
    params: {
        readonly ticketId: string;
        readonly authorId: AccountId;
        readonly fromStaff: boolean;
        readonly body: string | null;
        readonly plan: { readonly state: TicketState; readonly writes: boolean };
        readonly txNow: EpochMs;
    },
): Promise<Result<void, DbFailure>> {
    const at = toTimestamptz(params.txNow);
    if (params.plan.writes) {
        invariant(params.body !== null, "an event that writes carries a body");
        const written = await execute(
            tx,
            sql`insert into ticket_message (ticket_id, author_id, from_staff, body, created_at)
                values (${params.ticketId}::uuid, ${params.authorId}, ${params.fromStaff},
                        ${params.body}, ${at}::timestamptz)`,
        );
        if (!written.ok) return written;
    }
    const closed = params.plan.state === "closed";
    const updated = await execute(
        tx,
        sql`update ticket
            set state = ${params.plan.state},
                last_activity_at = ${at}::timestamptz,
                closed_at = ${closed ? sql`coalesce(closed_at, ${at}::timestamptz)` : sql`null`}
            where id = ${params.ticketId}::uuid`,
    );
    if (!updated.ok) return updated;
    return ok(undefined);
}

const Message = z.object({
    id: z.string(),
    fromStaff: z.boolean(),
    body: z.string(),
    at: EpochMs,
    authorId: AccountId,
    authorUsername: z.string().nullable(),
});

export async function readThread(q: Queryable, ticketId: string) {
    return await queryAll(
        q,
        Message,
        sql`select m.id::text as id, m.from_staff as "fromStaff", m.body, m.created_at as at,
                   m.author_id as "authorId", a.username as "authorUsername"
            from ticket_message m join account a on a.id = m.author_id
            where m.ticket_id = ${ticketId}::uuid
            order by m.id limit ${MESSAGES_PER_TICKET}`,
    );
}

const ConsentRow = z.object({ granted: z.boolean(), at: EpochMs });

export type Consent = z.output<typeof ConsentRow>;

// The member's latest word on support reading their configs for this ticket; null when they
// never said.
export async function findConsent(q: Queryable, ticketId: string) {
    return await queryOne(
        q,
        ConsentRow,
        sql`select granted, at from ticket_consent
            where ticket_id = ${ticketId}::uuid and scope = 'config'
            order by id desc limit 1`,
    );
}

// --- members ---

const Summary = z.object({
    id: z.string(),
    subject: z.string(),
    productId: ProductId.nullable(),
    state: State,
    openedAt: EpochMs,
    lastActivityAt: EpochMs,
});

const SUMMARY_COLUMNS = sql`t.id::text as id, t.subject, t.product_id as "productId", t.state,
    t.opened_at as "openedAt", t.last_activity_at as "lastActivityAt"`;

// The member's help tickets, latest activity first. Their appeal, if any, lives on /appeal.
export function listMemberTickets(
    db: Db,
    token: BearerToken,
    params: { readonly cursor: string | null },
) {
    return withMember(db, token, async (tx, accountId) => {
        const after =
            params.cursor === null
                ? sql``
                : sql`and (t.last_activity_at, t.id) < (
                      select c.last_activity_at, c.id from ticket c
                      where c.id = ${params.cursor}::uuid and c.account_id = ${accountId})`;
        const rows = await queryAll(
            tx,
            Summary,
            sql`select ${SUMMARY_COLUMNS} from ticket t
                where t.account_id = ${accountId} and t.kind = 'help' ${after}
                order by t.last_activity_at desc, t.id desc limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        return ok(pageOf(rows.value));
    });
}

export function openMemberTicket(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly productId: ProductId | null;
        readonly subject: string;
        readonly body: string;
    },
) {
    return withMember(db, token, (tx, accountId) => openTicketFor(tx, { ...params, accountId }));
}

// The one way a help ticket is opened, from the site or from Discord's /ticket: the product must
// be listed for the account, and the same limits hold. The caller has locked the account.
export async function openTicketFor(
    tx: Tx,
    params: {
        readonly accountId: AccountId;
        readonly catalog: ProductCatalog;
        readonly productId: ProductId | null;
        readonly subject: string;
        readonly body: string;
    },
) {
    const { accountId } = params;
    if (params.productId !== null) {
        const listed = await isListedForMember(
            tx,
            { accountId, catalog: params.catalog },
            params.productId,
        );
        if (!listed.ok) return listed;
        if (!listed.value) return err({ code: "UNKNOWN_PRODUCT" as const });
    }
    const counts = await queryOne(
        tx,
        z.object({ unclosed: z.coerce.number().int(), today: z.coerce.number().int() }),
        sql`select count(*) filter (where state <> 'closed') as unclosed,
                       count(*) filter (where opened_at > now() - interval '1 day') as today
                from ticket where account_id = ${accountId} and kind = 'help'`,
    );
    if (!counts.ok) return counts;
    const allowed = decideOpenTicket({
        unclosed: counts.value?.unclosed ?? 0,
        openedToday: counts.value?.today ?? 0,
    });
    if (!allowed.ok) return allowed;
    const created = await queryOne(
        tx,
        z.object({ id: z.string(), now: EpochMs }),
        sql`insert into ticket
                    (account_id, kind, product_id, subject, state, opened_at, last_activity_at)
                values (${accountId}, 'help', ${params.productId}, ${params.subject}, 'open',
                        now(), now())
                returning id::text as id, opened_at as now`,
    );
    if (!created.ok) return created;
    invariant(created.value !== null, "an insert returns its row");
    const written = await execute(
        tx,
        sql`insert into ticket_message (ticket_id, author_id, from_staff, body, created_at)
                values (${created.value.id}::uuid, ${accountId}, false, ${params.body}, now())`,
    );
    if (!written.ok) return written;
    return ok({ ticketId: created.value.id });
}

// What the member sees of a message: theirs or staff's, never which staff account wrote it.
function toMemberMessage(message: z.output<typeof Message>) {
    return { id: message.id, fromStaff: message.fromStaff, body: message.body, at: message.at };
}

export function readMemberTicket(
    db: Db,
    token: BearerToken,
    params: { readonly ticketId: string },
) {
    return withMember(db, token, async (tx, accountId) => {
        const ticket = await queryOne(
            tx,
            Summary,
            sql`select ${SUMMARY_COLUMNS} from ticket t
                where t.id = ${params.ticketId}::uuid and t.account_id = ${accountId}
                  and t.kind = 'help'`,
        );
        if (!ticket.ok) return ticket;
        if (ticket.value === null) return err({ code: "NOT_FOUND" as const });
        const thread = await readThread(tx, params.ticketId);
        if (!thread.ok) return thread;
        const consent = await findConsent(tx, params.ticketId);
        if (!consent.ok) return consent;
        return ok({
            ...ticket.value,
            messages: thread.value.map(toMemberMessage),
            configConsent: consent.value,
        });
    });
}

// The member's side of a ticket that already exists: writing, closing, or answering whether
// support may read their configs for it.
function actAsMember(
    db: Db,
    token: BearerToken,
    params: {
        readonly ticketId: string;
        readonly event: Extract<TicketEvent, `member_${string}`>;
        readonly body: string | null;
        readonly consent?: boolean;
    },
) {
    return withMember(db, token, async (tx, accountId) => {
        const txNow = await nowOf(tx);
        if (!txNow.ok) return txNow;
        const ticket = await lockTicket(tx, params.ticketId);
        if (!ticket.ok) return ticket;
        const help = ticket.value?.kind === "help" ? ticket.value : null;
        const plan = decideTicket({
            ticket:
                help === null
                    ? null
                    : { accountId: help.account_id, state: help.state, messages: help.messages },
            actorId: accountId,
            event: params.event,
        });
        if (!plan.ok) return plan;
        if (params.consent !== undefined) {
            const recorded = await execute(
                tx,
                sql`insert into ticket_consent (ticket_id, account_id, scope, granted, at)
                    values (${params.ticketId}::uuid, ${accountId}, 'config', ${params.consent},
                            ${toTimestamptz(txNow.value)}::timestamptz)`,
            );
            if (!recorded.ok) return recorded;
            return ok(undefined);
        }
        if (!plan.value.changed) return ok(undefined);
        if (plan.value.reopened) {
            // Consent was given for the conversation that closed; a reopened ticket asks again.
            const lapsed = await execute(
                tx,
                sql`insert into ticket_consent (ticket_id, account_id, scope, granted, at)
                    select ${params.ticketId}::uuid, ${accountId}, 'config', false,
                           ${toTimestamptz(txNow.value)}::timestamptz
                    where (select granted from ticket_consent
                           where ticket_id = ${params.ticketId}::uuid and scope = 'config'
                           order by id desc limit 1)`,
            );
            if (!lapsed.ok) return lapsed;
        }
        return await applyTicketEvent(tx, {
            ticketId: params.ticketId,
            authorId: accountId,
            fromStaff: false,
            body: params.body,
            plan: plan.value,
            txNow: txNow.value,
        });
    });
}

async function nowOf(tx: Tx): Promise<Result<EpochMs, DbFailure>> {
    const row = await queryOne(tx, z.object({ now: EpochMs }), sql`select now() as now`);
    if (!row.ok) return row;
    invariant(row.value !== null, "now() returns a row");
    return ok(row.value.now);
}

export function writeMemberTicket(
    db: Db,
    token: BearerToken,
    params: { readonly ticketId: string; readonly body: string },
) {
    return actAsMember(db, token, { ...params, event: "member_wrote" });
}

export function closeMemberTicket(
    db: Db,
    token: BearerToken,
    params: { readonly ticketId: string },
) {
    return actAsMember(db, token, { ...params, event: "member_closed", body: null });
}

export function setTicketConsent(
    db: Db,
    token: BearerToken,
    params: { readonly ticketId: string; readonly granted: boolean },
) {
    return actAsMember(db, token, {
        ticketId: params.ticketId,
        event: "member_consented",
        body: null,
        consent: params.granted,
    });
}

// --- staff ---

const StaffSummary = z.object({
    id: z.string(),
    kind: Kind,
    subject: z.string().nullable(),
    productId: ProductId.nullable(),
    state: State,
    accountId: AccountId,
    username: z.string().nullable(),
    openedAt: EpochMs,
    lastActivityAt: EpochMs,
});

const STAFF_COLUMNS = sql`t.id::text as id, t.kind, t.subject, t.product_id as "productId",
    t.state, t.account_id as "accountId", a.username, t.opened_at as "openedAt",
    t.last_activity_at as "lastActivityAt"`;

function toStaffSummary(row: z.output<typeof StaffSummary>) {
    const { accountId, username, ...rest } = row;
    return { ...rest, account: { id: accountId, username } };
}

// Open tickets longest waiting first, so the queue is worked in order; answered and closed ones
// latest first.
export function listStaffTickets(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly state: TicketState;
        readonly cursor: string | null;
    },
) {
    const oldestFirst = params.state === "open";
    return readAsStaff(db, { caller: params.caller, actions: [TICKET_ACTION] }, async (q) => {
        // The cursor ticket is found whatever its state is now: staff answering the last ticket
        // of a page must not end the list.
        const after =
            params.cursor === null
                ? sql``
                : oldestFirst
                  ? sql`and (t.last_activity_at, t.id) > (
                        select c.last_activity_at, c.id from ticket c
                        where c.id = ${params.cursor}::uuid)`
                  : sql`and (t.last_activity_at, t.id) < (
                        select c.last_activity_at, c.id from ticket c
                        where c.id = ${params.cursor}::uuid)`;
        const rows = await queryAll(
            q,
            StaffSummary,
            sql`select ${STAFF_COLUMNS} from ticket t join account a on a.id = t.account_id
                where t.state = ${params.state} ${after}
                order by ${oldestFirst ? sql`t.last_activity_at, t.id` : sql`t.last_activity_at desc, t.id desc`}
                limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const page = pageOf(rows.value);
        return ok({ items: page.items.map(toStaffSummary), nextCursor: page.nextCursor });
    });
}

export function readStaffTicket(
    db: Db,
    params: { readonly caller: Caller; readonly ticketId: string },
) {
    return readAsStaff(db, { caller: params.caller, actions: [TICKET_ACTION] }, async (q) => {
        const ticket = await queryOne(
            q,
            StaffSummary.extend({ status: z.enum(["active", "suspended", "deleted"]) }),
            sql`select ${STAFF_COLUMNS},
                       case when a.deleted_at is not null then 'deleted' else a.status end as status
                from ticket t
                join account a on a.id = t.account_id where t.id = ${params.ticketId}::uuid`,
        );
        if (!ticket.ok) return ticket;
        if (ticket.value === null) return err<NotFound | DbFailure>({ code: "NOT_FOUND" });
        const { status, ...summary } = ticket.value;
        const thread = await readThread(q, params.ticketId);
        if (!thread.ok) return thread;
        const consent = await findConsent(q, params.ticketId);
        if (!consent.ok) return consent;
        const suspension =
            summary.kind === "appeal" ? await findSuspension(q, summary.accountId) : ok(null);
        if (!suspension.ok) return suspension;
        return ok({
            ...toStaffSummary(summary),
            accountStatus: status,
            messages: thread.value.map(({ authorId, authorUsername, ...message }) => ({
                ...message,
                author: { id: authorId, username: authorUsername },
            })),
            configConsent: consent.value,
            configReadable: decideConfigRead({
                ticketState: summary.state,
                consent: consent.value,
            }).ok,
            suspension: suspension.value,
        });
    });
}

export type StaffTicketRefusal = AuthzRefusal | TicketRefusal;

// What a reply needs to tell the member: the site's origin for the mail's link, and whether a
// mail provider exists (without one nothing would drain the outbox).
export type ReplySite = { readonly origin: string; readonly mail: boolean };

function actAsStaff(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly ticketId: string;
        readonly event: "staff_replied" | "staff_closed";
        readonly body: string | null;
        readonly site: ReplySite | null;
    },
): Promise<Result<void, StaffTicketRefusal | DbFailure>> {
    return withTx(db, async (tx, txNow) => {
        // Lock order (platform/AGENTS.md): accounts by id (staff caller and ticket owner
        // together), then the ticket, then the append-only notice and audit rows. The owner is
        // known only from the ticket, which never changes hands, so it is read before any lock
        // and checked again once the ticket is locked.
        const owner = await queryOne(
            tx,
            z.object({ account_id: AccountId }),
            sql`select account_id from ticket where id = ${params.ticketId}::uuid`,
        );
        if (!owner.ok) return owner;
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: owner.value === null ? [] : [owner.value.account_id],
            txNow,
        });
        if (!locked.ok) return locked;
        const authorized = authorize({
            txNow,
            subject: locked.value.subject,
            action: TICKET_ACTION,
        });
        if (!authorized.ok) return authorized;
        const ticket = await lockTicket(tx, params.ticketId);
        if (!ticket.ok) return ticket;
        // A ticket gone since the first read is refused below as missing; one still there
        // belongs to whoever it belonged to.
        invariant(
            ticket.value === null || ticket.value.account_id === owner.value?.account_id,
            "a ticket's account never changes",
        );
        const plan = decideTicket({
            ticket:
                ticket.value === null
                    ? null
                    : {
                          accountId: ticket.value.account_id,
                          state: ticket.value.state,
                          messages: ticket.value.messages,
                      },
            actorId: params.caller.accountId,
            event: params.event,
        });
        if (!plan.ok) return plan;
        invariant(ticket.value !== null, "a ticket allowed an event exists");
        if (!plan.value.changed) return ok(undefined);
        const applied = await applyTicketEvent(tx, {
            ticketId: params.ticketId,
            authorId: params.caller.accountId,
            fromStaff: true,
            body: params.body,
            plan: plan.value,
            txNow,
        });
        if (!applied.ok) return applied;
        // An appeal's account is suspended and reaches only /appeal: no inbox entry or mail.
        // The same holds for a help ticket whose owner was suspended since opening it: the
        // notice says "sign in to read it", and they can't. The row is locked above, so the
        // standing read here is the one the reply commits with.
        const standing = await queryOne(
            tx,
            z.object({ status: z.enum(["active", "suspended"]), is_deleted: z.boolean() }),
            sql`select status, deleted_at is not null as is_deleted
                from account where id = ${ticket.value.account_id}`,
        );
        if (!standing.ok) return standing;
        // A deleted owner has no inbox and no address; their ticket waits out its 30 days.
        const reachable = standing.value?.status === "active" && !standing.value.is_deleted;
        if (params.event === "staff_replied" && ticket.value.kind === "help" && reachable) {
            invariant(params.site !== null, "a reply knows the site it tells the member about");
            const notified = await recordNotification(tx, {
                recipient: ticket.value.account_id,
                notice: {
                    kind: "ticket_reply",
                    productId: null,
                    ticketId: params.ticketId,
                    origin: params.site.origin,
                },
                mail: params.site.mail,
            });
            if (!notified.ok) return notified;
        }
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: params.event === "staff_replied" ? "ticket.reply" : "ticket.close",
            target: {
                accountId: ticket.value.account_id,
                ticketId: params.ticketId,
                kind: ticket.value.kind,
            },
            at: txNow,
        });
    });
}

export function replyToTicket(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly ticketId: string;
        readonly body: string;
        readonly site: ReplySite;
    },
) {
    return actAsStaff(db, { ...params, event: "staff_replied" });
}

export function closeStaffTicket(
    db: Db,
    params: { readonly caller: Caller; readonly ticketId: string },
) {
    return actAsStaff(db, { ...params, event: "staff_closed", body: null, site: null });
}

// --- the idle job ---

const IDLE_EVERY_MS = 10 * 60 * 1_000;

// How many answered tickets closed for want of the member's reply.
export async function closeIdleTickets(db: Db): Promise<Result<number, DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const cutoff = decideIdleCutoff(txNow);
        if (!cutoff.ok) return cutoff;
        return await execute(
            tx,
            sql`update ticket set state = 'closed', closed_at = ${toTimestamptz(txNow)}::timestamptz
                where state = 'answered'
                  and last_activity_at <= ${toTimestamptz(cutoff.value)}::timestamptz`,
        );
    });
}

export function idleTicketJob(db: Db): Job {
    return {
        name: "idle-tickets",
        everyMs: IDLE_EVERY_MS,
        run: async () => {
            const closed = await closeIdleTickets(db);
            if (!closed.ok) return closed;
            return ok(closed.value === 0 ? null : `closed ${closed.value} idle tickets`);
        },
    };
}
