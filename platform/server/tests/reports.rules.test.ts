import { expect, test } from "bun:test";
import { decideReportsAnswer, MAX_REPORTS_PER_SESSION } from "../src/runtime/reports.rules.ts";

const route = { inSequence: 4n, outSequence: 3n, stored: 10, batch: 5 };

test.each([
    ["a newer frame, answered at the next sequence", 5n, null, 10, { sequence: 3n, store: 5 }],
    ["a frame far ahead", 90n, null, 10, { sequence: 3n, store: 5 }],
    [
        "a batch that only partly fits",
        5n,
        null,
        MAX_REPORTS_PER_SESSION - 2,
        { sequence: 3n, store: 2 },
    ],
    ["a batch into a full session", 5n, null, MAX_REPORTS_PER_SESSION, { sequence: 3n, store: 0 }],
    [
        "a session somehow past its cap",
        5n,
        null,
        MAX_REPORTS_PER_SESSION + 7,
        { sequence: 3n, store: 0 },
    ],
    ["a retry of the last answer", 4n, 2n, 10, { sequence: 2n, store: null }],
] as const)("%s", (_, frameSequence, replayed, stored, expected) => {
    expect(decideReportsAnswer({ ...route, frameSequence, replayed, stored })).toEqual({
        ok: true,
        value: expected,
    });
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
