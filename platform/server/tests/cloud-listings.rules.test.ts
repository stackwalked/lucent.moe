import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import {
    CONTENT_SHOWN_MAX_BYTES,
    decideApproval,
    decideFirstPin,
    decideListingContent,
    decideRepin,
    listingName,
} from "../src/delivery/cloud/listings.rules.ts";

test.each([
    ["a config goes straight to listed", "config", { state: "listed", revision: 4, pending: null }],
    [
        "an inventory goes straight to listed",
        "inventory",
        { state: "listed", revision: 4, pending: null },
    ],
    ["a script waits for staff", "script", { state: "pending", revision: null, pending: 4 }],
] as const)("the first pin: %s", (_name, kind, expected) => {
    expect(decideFirstPin({ kind, head: 4 })).toEqual(expected);
});

test.each([
    [
        "a config moves to the new head at once",
        "config",
        { state: "listed", revision: 2, pending: null },
        { state: "listed", revision: 5, pending: null },
    ],
    [
        "a listed script keeps its approved snapshot while the new one waits",
        "script",
        { state: "listed", revision: 2, pending: null },
        { state: "listed", revision: 2, pending: 5 },
    ],
    [
        "a listed script's older waiting snapshot is replaced by the new head",
        "script",
        { state: "listed", revision: 2, pending: 3 },
        { state: "listed", revision: 2, pending: 5 },
    ],
    [
        "a script never approved stays pending, on the new head",
        "script",
        { state: "pending", revision: null, pending: 3 },
        { state: "pending", revision: null, pending: 5 },
    ],
    [
        "a head already pinned changes nothing, so words alone never send a script to staff",
        "script",
        { state: "listed", revision: 5, pending: null },
        { state: "listed", revision: 5, pending: null },
    ],
    [
        "a head already waiting changes nothing",
        "script",
        { state: "listed", revision: 2, pending: 5 },
        { state: "listed", revision: 2, pending: 5 },
    ],
    [
        "a config at its head stays listed",
        "config",
        { state: "listed", revision: 5, pending: null },
        { state: "listed", revision: 5, pending: null },
    ],
] as const)("re-pinning: %s", (_name, kind, current, expected) => {
    expect(decideRepin({ kind, current, head: 5 })).toEqual(expected);
});

test("approval makes the waiting snapshot the visible one, and with none waiting there is nothing to approve", () => {
    expect(decideApproval({ state: "pending", revision: null, pending: 3 }, 3)).toEqual(
        ok({ state: "listed", revision: 3, pending: null }),
    );
    expect(decideApproval({ state: "listed", revision: 2, pending: 5 }, 5)).toEqual(
        ok({ state: "listed", revision: 5, pending: null }),
    );
    expect(decideApproval({ state: "listed", revision: 2, pending: null }, 5)).toEqual(
        err({ code: "NOT_FOUND" }),
    );
});

test("a listing's name is cut at 60 code points, never inside one", () => {
    expect(listingName("a".repeat(64))).toBe("a".repeat(60));
    expect(listingName("🙂".repeat(64))).toBe("🙂".repeat(60));
    expect(listingName("short")).toBe("short");
});

test("approval is for the revision that was read: another waiting one is stale", () => {
    expect(decideApproval({ state: "listed", revision: 2, pending: 5 }, 4)).toEqual(
        err({ code: "STALE_REVISION" }),
    );
    expect(decideApproval({ state: "pending", revision: null, pending: 3 }, 2)).toEqual(
        err({ code: "STALE_REVISION" }),
    );
    // Nothing waiting is nothing to approve, whatever was read.
    expect(decideApproval({ state: "listed", revision: 2, pending: null }, 2)).toEqual(
        err({ code: "NOT_FOUND" }),
    );
});

const bytes = (value: string) => new TextEncoder().encode(value);

test.each([
    [
        "a script is its source, as written",
        "script",
        bytes("a = 1\n\tb = {}\n"),
        "a = 1\n\tb = {}\n",
    ],
    ["a script that is compact JSON is not laid out", "script", bytes('{"a":1}'), '{"a":1}'],
    [
        "compact JSON in a config is laid out",
        "config",
        bytes('{"a":[1,2]}'),
        '{\n  "a": [\n    1,\n    2\n  ]\n}',
    ],
    ["JSON already laid out is left as it is", "inventory", bytes('{ "a": 1 }'), '{ "a": 1 }'],
    [
        "JSON that would not survive a round trip is left as it is",
        "config",
        bytes('{"n":12345678901234567890}'),
        '{"n":12345678901234567890}',
    ],
    ["other text is shown as it is", "config", bytes("key = value\r\n"), "key = value\r\n"],
    ["bytes that are not UTF-8 are not shown", "config", new Uint8Array([0xc3, 0x28]), null],
    ["a NUL makes it binary", "inventory", new Uint8Array([0x61, 0x00, 0x62]), null],
    [
        "another control character makes it binary",
        "script",
        new Uint8Array([0x61, 0x07, 0x62]),
        null,
    ],
    ["nothing at all is the empty text", "config", new Uint8Array(0), ""],
] as const)("what a page shows: %s", (_name, kind, content, expected) => {
    expect(decideListingContent({ kind, bytes: content })).toEqual({
        text: expected,
        size: content.byteLength,
    });
});

const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);

test("JSON nested 32 deep is laid out and 33 deep is left as written", () => {
    const at32 = decideListingContent({ kind: "config", bytes: bytes(nested(32)) });
    expect(at32.text).not.toBe(nested(32));
    expect(at32.text?.split("\n").length).toBe(63);
    expect(decideListingContent({ kind: "config", bytes: bytes(nested(33)) }).text).toBe(
        nested(33),
    );
});

test("48 KB of brackets is returned as written, without laying it out", () => {
    const input = nested(24000);
    const started = performance.now();
    const shown = decideListingContent({ kind: "inventory", bytes: bytes(input) });
    expect(shown.text).toBe(input);
    expect(performance.now() - started).toBeLessThan(1000);
});

test("brackets inside strings do not count as nesting", () => {
    const text = JSON.stringify({ a: `${"[".repeat(100)}\\"${"{".repeat(100)}` });
    expect(decideListingContent({ kind: "config", bytes: bytes(text) }).text).toContain('\n  "a"');
});

test("a laid-out form past 1 MiB is left as written", () => {
    // 40000 numbers at the bottom of 31 arrays: 80 KB compact, each on its own 64-space line laid out.
    const compact = `${"[".repeat(31)}[${"1,".repeat(39999)}1]${"]".repeat(31)}`;
    expect(compact.length).toBeLessThan(CONTENT_SHOWN_MAX_BYTES);
    expect(decideListingContent({ kind: "config", bytes: bytes(compact) }).text).toBe(compact);
});

test("above 256 KB nothing is shown, and the size still is", () => {
    const big = new Uint8Array(CONTENT_SHOWN_MAX_BYTES + 1).fill(0x61);
    expect(decideListingContent({ kind: "script", bytes: big })).toEqual({
        text: null,
        size: CONTENT_SHOWN_MAX_BYTES + 1,
    });
    const edge = new Uint8Array(CONTENT_SHOWN_MAX_BYTES).fill(0x61);
    expect(decideListingContent({ kind: "script", bytes: edge }).text).toHaveLength(
        CONTENT_SHOWN_MAX_BYTES,
    );
});
