import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { CREDENTIAL_FRESHNESS_MS } from "../src/auth/sessions.ts";
import {
    DELETION_EVENTS,
    DELETION_GRACE_MS,
    type DeletionEvent,
    type DeletionFacts,
    type DeletionState,
    decideDeletion,
} from "../src/deletion/deletion.rules.ts";

const now = EpochMs.parse(100_000_000_000);
const due = EpochMs.parse(now - 1);
const notYet = EpochMs.parse(now + 1);

const STATES = {
    none: { kind: "none" },
    "pending, due": { kind: "pending", dueAt: due },
    "pending, not yet due": { kind: "pending", dueAt: notYet },
    completed: { kind: "completed" },
} as const satisfies Record<string, DeletionState>;

type StateName = keyof typeof STATES;

const STATE_NAMES = [
    "none",
    "pending, due",
    "pending, not yet due",
    "completed",
] as const satisfies readonly StateName[];

function outcome(state: DeletionState, event: DeletionEvent, facts: DeletionFacts): string {
    const decided = decideDeletion({ state, event, facts });
    if (!decided.ok) return decided.error.code;
    return decided.value.kind;
}

// A member who signed in a moment ago and holds no role: what every state does with every event.
const MEMBER: DeletionFacts = { isRoot: false, holdsRole: false, lastProofAt: now, now };
const TABLE: Readonly<Record<StateName, Readonly<Record<DeletionEvent, string>>>> = {
    none: { request: "request", cancel: "unchanged", complete: "NOT_PENDING" },
    "pending, due": { request: "unchanged", cancel: "cancel", complete: "complete" },
    "pending, not yet due": { request: "unchanged", cancel: "cancel", complete: "NOT_DUE" },
    completed: {
        request: "ACCOUNT_DELETED",
        cancel: "ACCOUNT_DELETED",
        complete: "ACCOUNT_DELETED",
    },
};

const pairs = STATE_NAMES.flatMap((name) =>
    DELETION_EVENTS.map((event) => [name, event, TABLE[name][event]] as const),
);

test.each(pairs)("for a member, a deletion %s meeting %s: %s", (name, event, expected) => {
    expect(outcome(STATES[name], event, MEMBER)).toBe(expected);
});

test("the table covers every state and every event", () => {
    expect(pairs).toHaveLength(STATE_NAMES.length * DELETION_EVENTS.length);
});

// Staff and root are demoted first. Cancelling is never refused for it: keeping an account is
// always allowed, and a role granted during the grace period holds the deletion rather than
// letting it run.
const STAFF: Readonly<Record<StateName, Readonly<Record<DeletionEvent, string>>>> = {
    none: { request: "STAFF_CANNOT_DELETE", cancel: "unchanged", complete: "STAFF_CANNOT_DELETE" },
    "pending, due": {
        request: "STAFF_CANNOT_DELETE",
        cancel: "cancel",
        complete: "STAFF_CANNOT_DELETE",
    },
    "pending, not yet due": {
        request: "STAFF_CANNOT_DELETE",
        cancel: "cancel",
        complete: "STAFF_CANNOT_DELETE",
    },
    completed: {
        request: "ACCOUNT_DELETED",
        cancel: "ACCOUNT_DELETED",
        complete: "ACCOUNT_DELETED",
    },
};

test.each(
    (["role", "root"] as const).flatMap((who) =>
        STATE_NAMES.flatMap((name) =>
            DELETION_EVENTS.map((event) => [who, name, event, STAFF[name][event]] as const),
        ),
    ),
)("for an account holding %s, a deletion %s meeting %s: %s", (who, name, event, expected) => {
    const facts = { ...MEMBER, isRoot: who === "root", holdsRole: who === "role" };
    expect(outcome(STATES[name], event, facts)).toBe(expected);
});

test.each([
    ["at sign-in a moment ago", now, "request"],
    [
        "at the edge of the freshness window",
        EpochMs.parse(now - CREDENTIAL_FRESHNESS_MS),
        "request",
    ],
    ["just past it", EpochMs.parse(now - CREDENTIAL_FRESHNESS_MS - 1), "REAUTH_REQUIRED"],
    ["never", null, "REAUTH_REQUIRED"],
] as const)(
    "a request whose session last proved a factor %s: %s",
    (_when, lastProofAt, expected) => {
        expect(outcome(STATES.none, "request", { ...MEMBER, lastProofAt })).toBe(expected);
    },
);

test("a stale proof does not stand in the way of a request already waiting", () => {
    expect(
        outcome(STATES["pending, not yet due"], "request", { ...MEMBER, lastProofAt: null }),
    ).toBe("unchanged");
});

test("a request is due seven days from the moment it is made, and a repeat keeps that date", () => {
    expect(decideDeletion({ state: STATES.none, event: "request", facts: MEMBER })).toEqual({
        ok: true,
        value: { kind: "request", dueAt: EpochMs.parse(now + DELETION_GRACE_MS) },
    });
    expect(
        decideDeletion({ state: STATES["pending, not yet due"], event: "request", facts: MEMBER }),
    ).toEqual({ ok: true, value: { kind: "unchanged", dueAt: notYet } });
});
