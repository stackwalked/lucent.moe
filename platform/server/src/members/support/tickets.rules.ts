import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

// A ticket is open while it waits on staff, answered while it waits on the member, and closed
// when either side closes it or the member leaves an answer unread for a week. The member writing
// again reopens a closed ticket; staff can't write into a closed one, since nobody would be
// waiting for it.
export type TicketState = "open" | "answered" | "closed";

export type TicketEvent =
    | "member_wrote"
    | "member_closed"
    | "member_consented"
    | "staff_replied"
    | "staff_closed";

export type TicketRefusal =
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "FORBIDDEN" }
    | { readonly code: "TICKET_CLOSED" }
    | { readonly code: "TICKET_FULL" };

export type GatheredTicket = {
    readonly accountId: string;
    readonly state: TicketState;
    readonly messages: number;
};

export type TicketPlan = {
    readonly state: TicketState;
    // The event adds a message to the thread.
    readonly writes: boolean;
    // Anything about the ticket changes: its state, or a message counts as activity.
    readonly changed: boolean;
    readonly reopened: boolean;
};

// A thread is a conversation, not a log: past this, the member opens a new ticket.
export const MESSAGES_PER_TICKET = 100;

const MEMBER_EVENTS: ReadonlySet<TicketEvent> = new Set([
    "member_wrote",
    "member_closed",
    "member_consented",
]);

const WRITES: ReadonlySet<TicketEvent> = new Set(["member_wrote", "staff_replied"]);

function nextState(state: TicketState, event: TicketEvent): TicketState {
    switch (event) {
        case "member_wrote":
            return "open";
        case "staff_replied":
            return "answered";
        case "member_closed":
        case "staff_closed":
            return "closed";
        case "member_consented":
            return state;
    }
}

// Someone else's ticket is NOT_FOUND to a member, as a missing one is. Staff never act on a
// ticket of their own account, as no staff action targets the caller's own.
export function decideTicket(params: {
    readonly ticket: GatheredTicket | null;
    readonly actorId: string;
    readonly event: TicketEvent;
}): Result<TicketPlan, TicketRefusal> {
    const { ticket, event } = params;
    const byMember = MEMBER_EVENTS.has(event);
    if (ticket === null) return err({ code: "NOT_FOUND" });
    if (byMember && ticket.accountId !== params.actorId) return err({ code: "NOT_FOUND" });
    if (!byMember && ticket.accountId === params.actorId) return err({ code: "FORBIDDEN" });
    const closed = ticket.state === "closed";
    if (closed && (event === "staff_replied" || event === "member_consented")) {
        return err({ code: "TICKET_CLOSED" });
    }
    const writes = WRITES.has(event);
    if (writes && ticket.messages >= MESSAGES_PER_TICKET) return err({ code: "TICKET_FULL" });
    const state = nextState(ticket.state, event);
    return ok({
        state,
        writes,
        changed: writes || state !== ticket.state,
        reopened: closed && state !== "closed",
    });
}

// Enough tickets waiting at once that one more is noise for whoever answers them.
export const UNCLOSED_TICKETS_PER_ACCOUNT = 10;

// Opening and closing in a loop would otherwise never meet the limit above.
export const TICKETS_PER_DAY = 20;

export function decideOpenTicket(params: {
    readonly unclosed: number;
    readonly openedToday: number;
}): Result<void, { readonly code: "TICKET_LIMIT" }> {
    return params.unclosed >= UNCLOSED_TICKETS_PER_ACCOUNT || params.openedToday >= TICKETS_PER_DAY
        ? err({ code: "TICKET_LIMIT" })
        : ok(undefined);
}

const IDLE_MS = 7 * 24 * 60 * 60 * 1_000;

// Answered tickets whose last activity is at or before this close. One still open waits on staff
// and never closes for idleness: nobody has answered it yet.
export function decideIdleCutoff(txNow: EpochMs): Result<EpochMs, never> {
    return ok(EpochMs.parse(Math.max(0, txNow - IDLE_MS)));
}

// Support reads a member's configs only on a ticket that is still open and whose member's latest
// word on it is yes. Every staff read of a member's config goes through this.
export function decideConfigRead(params: {
    readonly ticketState: TicketState;
    readonly consent: { readonly granted: boolean } | null;
}): Result<void, { readonly code: "CONSENT_REQUIRED" }> {
    if (params.ticketState === "closed" || params.consent?.granted !== true) {
        return err({ code: "CONSENT_REQUIRED" });
    }
    return ok(undefined);
}
