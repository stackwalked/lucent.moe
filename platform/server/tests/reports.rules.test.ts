import { expect, test } from "bun:test";
import {
    decideReportsAnswer,
    MAX_REPORTS_PER_ACCOUNT_DAY,
    MAX_REPORTS_PER_SESSION,
} from "../src/delivery/runtime/reports.rules.ts";

const route = { inSequence: 4n, outSequence: 3n, stored: 10, accountStored: 10, batch: 5 };
const SESSION = MAX_REPORTS_PER_SESSION;
const ACCOUNT = MAX_REPORTS_PER_ACCOUNT_DAY;

test.each([
    ["a newer frame, answered at the next sequence", 5n, null, 10, 10, { sequence: 3n, store: 5 }],
    ["a frame far ahead", 90n, null, 10, 10, { sequence: 3n, store: 5 }],
    [
        "a batch that only partly fits the session",
        5n,
        null,
        SESSION - 2,
        500,
        { sequence: 3n, store: 2 },
    ],
    ["a batch into a full session", 5n, null, SESSION, SESSION, { sequence: 3n, store: 0 }],
    [
        "a session somehow past its cap",
        5n,
        null,
        SESSION + 7,
        SESSION + 7,
        { sequence: 3n, store: 0 },
    ],
    [
        "a batch that only partly fits the account's day",
        5n,
        null,
        0,
        ACCOUNT - 3,
        { sequence: 3n, store: 3 },
    ],
    [
        "a fresh session of an account whose day is full",
        5n,
        null,
        0,
        ACCOUNT,
        { sequence: 3n, store: 0 },
    ],
    ["an account somehow past its day", 5n, null, 0, ACCOUNT + 50, { sequence: 3n, store: 0 }],
    ["a retry of the last answer", 4n, 2n, 10, ACCOUNT, { sequence: 2n, store: null }],
] as const)("%s", (_, frameSequence, replayed, stored, accountStored, expected) => {
    expect(
        decideReportsAnswer({ ...route, frameSequence, replayed, stored, accountStored }),
    ).toEqual({ ok: true, value: expected });
});

test.each([
    ["the last accepted frame again", 4n, null],
    ["an older frame", 1n, null],
    ["a retry of an answer the route has since moved past", 4n, 1n],
] as const)("%s is stale", (_, frameSequence, replayed) => {
    expect(decideReportsAnswer({ ...route, frameSequence, replayed })).toEqual({
        ok: false,
        error: { code: "STALE_SEQUENCE" },
    });
});
