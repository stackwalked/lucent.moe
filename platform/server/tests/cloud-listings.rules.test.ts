import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import {
    decideApproval,
    decideFirstPin,
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
