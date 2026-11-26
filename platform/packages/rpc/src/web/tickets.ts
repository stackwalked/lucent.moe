import { AccountId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, refusal, StaffRefusals, Unavailable } from "./shared.ts";

// Help tickets: members open and follow their own; staff with tickets:reply answer all of them,
// appeals included. A ticket is open while it waits on staff, answered while it waits on the
// member (closing by itself after a week of that), closed when either side closes it; the
// member writing again reopens it.

export const TicketId = z.uuid();
export const TicketState = z.enum(["open", "answered", "closed"]);
export const TicketKind = z.enum(["help", "appeal"]);
export const TicketSubject = z.string().trim().min(1).max(120);
export const MessageBody = z.string().trim().min(1).max(4_000);

export const TicketMessage = z.object({
    id: z.string(),
    // The member sees that staff answered, never which staff account did.
    fromStaff: z.boolean(),
    body: z.string(),
    at: EpochMs,
});

// The member's latest word on support reading their configs for this ticket; null before any.
const ConfigConsent = z.object({ granted: z.boolean(), at: EpochMs }).nullable();

const MemberTicketSummary = z.object({
    id: TicketId,
    subject: z.string(),
    productId: ProductId.nullable(),
    state: TicketState,
    openedAt: EpochMs,
    lastActivityAt: EpochMs,
});

const Signed = z.discriminatedUnion("code", [Unavailable, refusal("SESSION_INVALID")]);

// Someone else's ticket is NOT_FOUND, as a missing one is. TICKET_CLOSED: the ticket closed
// meanwhile (consent is asked on an open ticket only). TICKET_FULL: the thread reached its
// length; open a new ticket.
export const TicketRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
    refusal("FORBIDDEN"),
    refusal("TICKET_CLOSED"),
    refusal("TICKET_FULL"),
]);

const StaffTicketSummary = z.object({
    id: TicketId,
    kind: TicketKind,
    // Null for an appeal, which has no subject.
    subject: z.string().nullable(),
    productId: ProductId.nullable(),
    state: TicketState,
    account: z.object({ id: AccountId, username: z.string().nullable() }),
    openedAt: EpochMs,
    lastActivityAt: EpochMs,
});

export const ticketsContract = defineContract({
    // The member's help tickets, latest activity first.
    "tickets.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ cursor: TicketId.nullable() }),
        output: z.object({
            items: z.array(MemberTicketSummary).readonly(),
            nextCursor: TicketId.nullable(),
        }),
        error: Signed,
    },
    "tickets.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({ ticketId: TicketId }),
        output: MemberTicketSummary.extend({
            messages: z.array(TicketMessage).readonly(),
            configConsent: ConfigConsent,
        }),
        error: z.discriminatedUnion("code", [
            Unavailable,
            refusal("SESSION_INVALID"),
            refusal("NOT_FOUND"),
        ]),
    },
    // UNKNOWN_PRODUCT: the product isn't one the member can see. TICKET_LIMIT: too many of the
    // member's tickets are still open; close one first.
    "tickets.open": {
        session: "member",
        effect: "write",
        input: z.strictObject({
            productId: ProductId.nullable(),
            subject: TicketSubject,
            body: MessageBody,
        }),
        output: z.object({ ticketId: TicketId }),
        error: z.discriminatedUnion("code", [
            Unavailable,
            refusal("SESSION_INVALID"),
            refusal("UNKNOWN_PRODUCT"),
            refusal("TICKET_LIMIT"),
        ]),
    },
    "tickets.messages.send": {
        session: "member",
        effect: "write",
        input: z.strictObject({ ticketId: TicketId, body: MessageBody }),
        output: Done,
        error: TicketRefusal,
    },
    "tickets.close": {
        session: "member",
        effect: "write",
        input: z.strictObject({ ticketId: TicketId }),
        output: Done,
        error: TicketRefusal,
    },
    // Recorded, never edited: each answer is a new row, and the latest one counts.
    "tickets.consent.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({ ticketId: TicketId, granted: z.boolean() }),
        output: Done,
        error: TicketRefusal,
    },

    // Open tickets longest waiting first; answered and closed ones latest first.
    "admin.tickets.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ state: TicketState, cursor: TicketId.nullable() }),
        output: z.object({
            items: z.array(StaffTicketSummary).readonly(),
            nextCursor: TicketId.nullable(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    // `configReadable` says whether support may read the member's configs for this ticket now.
    // `suspension` is an appeal's, as staff recorded it; null for help tickets.
    "admin.tickets.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({ ticketId: TicketId }),
        output: StaffTicketSummary.extend({
            // "deleted": the owner deleted their account (no deleted owner exists before this web).
            accountStatus: z.enum(["active", "suspended", "deleted"]),
            messages: z
                .array(
                    TicketMessage.extend({
                        author: z.object({ id: AccountId, username: z.string().nullable() }),
                    }),
                )
                .readonly(),
            configConsent: ConfigConsent,
            configReadable: z.boolean(),
            suspension: z.object({ reason: z.string(), at: EpochMs }).nullable(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },
    // A ticket about the caller's own account is FORBIDDEN.
    "admin.tickets.reply": {
        session: "member",
        effect: "write",
        input: z.strictObject({ ticketId: TicketId, body: MessageBody }),
        output: Done,
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("TICKET_CLOSED"),
            refusal("TICKET_FULL"),
        ]),
    },
    "admin.tickets.close": {
        session: "member",
        effect: "write",
        input: z.strictObject({ ticketId: TicketId }),
        output: Done,
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("TICKET_CLOSED"),
            refusal("TICKET_FULL"),
        ]),
    },
});
