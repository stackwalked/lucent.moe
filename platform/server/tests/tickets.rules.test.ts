import { describe, expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import {
    decideConfigRead,
    decideIdleCutoff,
    decideOpenTicket,
    decideTicket,
    MESSAGES_PER_TICKET,
    TICKETS_PER_DAY,
    type TicketEvent,
    type TicketState,
    UNCLOSED_TICKETS_PER_ACCOUNT,
} from "../src/support/tickets.rules.ts";

const MEMBER = "acc_member";
const STAFF = "acc_staff";

function at(
    state: TicketState,
    event: TicketEvent,
    actorId = event.startsWith("member") ? MEMBER : STAFF,
) {
    return decideTicket({ ticket: { accountId: MEMBER, state, messages: 3 }, actorId, event });
}

describe("decideTicket", () => {
    const walk: readonly [TicketState, TicketEvent, TicketState, boolean][] = [
        ["open", "staff_replied", "answered", false],
        ["answered", "staff_replied", "answered", false],
        ["answered", "member_wrote", "open", false],
        ["open", "member_wrote", "open", false],
        ["open", "member_closed", "closed", false],
        ["answered", "staff_closed", "closed", false],
        ["closed", "member_wrote", "open", true],
        ["open", "member_consented", "open", false],
        ["answered", "member_consented", "answered", false],
    ];
    for (const [from, event, to, reopened] of walk) {
        test(`${event} on an ${from} ticket leaves it ${to}${reopened ? ", reopened" : ""}`, () => {
            const plan = at(from, event);
            expect(plan.ok && plan.value.state).toBe(to);
            expect(plan.ok && plan.value.reopened).toBe(reopened);
        });
    }

    test("a ticket walks open, answered, closed and reopened", () => {
        const states: TicketState[] = ["open"];
        for (const event of ["staff_replied", "member_closed", "member_wrote"] as const) {
            const plan = at(states.at(-1) ?? "open", event);
            invariant(plan.ok, `${event} is allowed in this walk`);
            states.push(plan.value.state);
        }
        expect(states).toEqual(["open", "answered", "closed", "open"]);
    });

    test("only writing events add a message, and consent changes nothing on the ticket", () => {
        expect(at("open", "member_wrote")).toMatchObject(ok({ writes: true, changed: true }));
        expect(at("open", "staff_replied")).toMatchObject(ok({ writes: true, changed: true }));
        expect(at("open", "member_closed")).toMatchObject(ok({ writes: false, changed: true }));
        expect(at("open", "member_consented")).toEqual(
            ok({ state: "open", writes: false, changed: false, reopened: false }),
        );
    });

    test("closing a closed ticket again changes nothing", () => {
        expect(at("closed", "member_closed")).toMatchObject(ok({ changed: false }));
        expect(at("closed", "staff_closed")).toMatchObject(ok({ changed: false }));
    });

    test("staff can't write into a closed ticket, and consent isn't asked on one", () => {
        expect(at("closed", "staff_replied")).toEqual(err({ code: "TICKET_CLOSED" }));
        expect(at("closed", "member_consented")).toEqual(err({ code: "TICKET_CLOSED" }));
    });

    test("another member's ticket is not found, a missing one too", () => {
        expect(at("open", "member_wrote", "acc_other")).toEqual(err({ code: "NOT_FOUND" }));
        expect(decideTicket({ ticket: null, actorId: MEMBER, event: "member_wrote" })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
    });

    test("staff never act on a ticket of their own account", () => {
        expect(at("open", "staff_replied", MEMBER)).toEqual(err({ code: "FORBIDDEN" }));
        expect(at("open", "staff_closed", MEMBER)).toEqual(err({ code: "FORBIDDEN" }));
    });

    test("a full thread takes no more messages but still closes", () => {
        const full = { accountId: MEMBER, state: "open" as const, messages: MESSAGES_PER_TICKET };
        expect(decideTicket({ ticket: full, actorId: MEMBER, event: "member_wrote" })).toEqual(
            err({ code: "TICKET_FULL" }),
        );
        expect(decideTicket({ ticket: full, actorId: STAFF, event: "staff_replied" })).toEqual(
            err({ code: "TICKET_FULL" }),
        );
        expect(decideTicket({ ticket: full, actorId: MEMBER, event: "member_closed" }).ok).toBe(
            true,
        );
    });
});

describe("decideOpenTicket", () => {
    test("a member opens tickets until too many are unclosed", () => {
        expect(
            decideOpenTicket({ unclosed: UNCLOSED_TICKETS_PER_ACCOUNT - 1, openedToday: 0 }),
        ).toEqual(ok(undefined));
        expect(
            decideOpenTicket({ unclosed: UNCLOSED_TICKETS_PER_ACCOUNT, openedToday: 0 }),
        ).toEqual(err({ code: "TICKET_LIMIT" }));
    });

    test("opening and closing in a loop meets the daily limit", () => {
        expect(decideOpenTicket({ unclosed: 0, openedToday: TICKETS_PER_DAY - 1 })).toEqual(
            ok(undefined),
        );
        expect(decideOpenTicket({ unclosed: 0, openedToday: TICKETS_PER_DAY })).toEqual(
            err({ code: "TICKET_LIMIT" }),
        );
    });
});

describe("decideIdleCutoff", () => {
    const DAY = 24 * 60 * 60 * 1_000;
    test("answers idle for seven days close, counted from now", () => {
        const now = EpochMs.parse(100 * DAY);
        expect(decideIdleCutoff(now)).toEqual(ok(EpochMs.parse(93 * DAY)));
    });
    test("the cutoff never goes before the epoch", () => {
        expect(decideIdleCutoff(EpochMs.parse(DAY))).toEqual(ok(EpochMs.parse(0)));
    });
});

describe("decideConfigRead", () => {
    const cases: readonly [TicketState, { readonly granted: boolean } | null, boolean][] = [
        ["open", { granted: true }, true],
        ["answered", { granted: true }, true],
        ["closed", { granted: true }, false],
        ["open", { granted: false }, false],
        ["open", null, false],
    ];
    for (const [ticketState, consent, readable] of cases) {
        test(`an ${ticketState} ticket with consent ${JSON.stringify(consent)} is ${readable ? "readable" : "not readable"}`, () => {
            expect(decideConfigRead({ ticketState, consent }).ok).toBe(readable);
        });
    }
});
