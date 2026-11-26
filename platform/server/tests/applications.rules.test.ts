import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import {
    APPLICATION_EVENTS,
    APPLICATION_STATES,
    type ApplicationEvent,
    type ApplicationState,
    decideApplication,
    REAPPLY_AFTER_MS,
} from "../src/identity/admission/applications.rules.ts";

const now = EpochMs.parse(100_000_000_000);
const decidedLongAgo = EpochMs.parse(now - REAPPLY_AFTER_MS);
const decidedRecently = EpochMs.parse(now - REAPPLY_AFTER_MS + 1);

// Every state against every event, for an address without an account and an application decided
// long enough ago to apply again: what each pair does, or which refusal it is.
const TABLE: Readonly<Record<ApplicationState, Readonly<Record<ApplicationEvent, string>>>> = {
    none: { submit: "open", approve: "NOT_FOUND", decline: "NOT_FOUND" },
    pending: { submit: "ignore", approve: "approve", decline: "decline" },
    approved: { submit: "ignore", approve: "ALREADY_DECIDED", decline: "ALREADY_DECIDED" },
    declined: { submit: "open", approve: "ALREADY_DECIDED", decline: "ALREADY_DECIDED" },
};

const pairs = APPLICATION_STATES.flatMap((state) =>
    APPLICATION_EVENTS.map((event) => [state, event, TABLE[state][event]] as const),
);

test.each(pairs)("an application %s meeting %s: %s", (state, event, expected) => {
    const decided = decideApplication({
        state,
        event,
        facts: {
            emailHasAccount: false,
            decidedAt: state === "approved" || state === "declined" ? decidedLongAgo : null,
            now,
        },
    });
    expect<string>(decided.ok ? decided.value : decided.error.code).toBe(expected);
});

test("the table covers every state and every event", () => {
    expect(pairs).toHaveLength(APPLICATION_STATES.length * APPLICATION_EVENTS.length);
});

// An address with an account: a submission changes nothing whatever its applications, and an
// approval would make a second account. A decision on a decided application is still refused for
// that.
const WITH_ACCOUNT: Readonly<Record<ApplicationState, Readonly<Record<ApplicationEvent, string>>>> =
    {
        none: { submit: "ignore", approve: "NOT_FOUND", decline: "NOT_FOUND" },
        pending: { submit: "ignore", approve: "EMAIL_TAKEN", decline: "decline" },
        approved: { submit: "ignore", approve: "ALREADY_DECIDED", decline: "ALREADY_DECIDED" },
        declined: { submit: "ignore", approve: "ALREADY_DECIDED", decline: "ALREADY_DECIDED" },
    };

test.each(
    APPLICATION_STATES.flatMap((state) =>
        APPLICATION_EVENTS.map((event) => [state, event, WITH_ACCOUNT[state][event]] as const),
    ),
)("for an address with an account, %s meeting %s: %s", (state, event, expected) => {
    const decided = decideApplication({
        state,
        event,
        facts: { emailHasAccount: true, decidedAt: decidedLongAgo, now },
    });
    expect<string>(decided.ok ? decided.value : decided.error.code).toBe(expected);
});

test.each([
    ["within the wait after a decline", decidedRecently, "ignore"],
    ["exactly when the wait ends", decidedLongAgo, "open"],
    ["with no decision time on record", null, "ignore"],
] as const)("applying again %s", (_, decidedAt, expected) => {
    const decided = decideApplication({
        state: "declined",
        event: "submit",
        facts: { emailHasAccount: false, decidedAt, now },
    });
    expect<string>(decided.ok ? decided.value : decided.error.code).toBe(expected);
});
