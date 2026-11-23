import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import { decideAppend } from "../src/cloud/items.rules.ts";

const limits = { maxItems: 2, maxStoredBytes: 8, maxVersionBytes: 4, maxVersionsPerItem: 3 };

test.each([
    [0, 0, 1, 4, 4, ok({ revision: 1, conflict: false })],
    [0, 0, 2, 4, 1, err({ code: "ITEM_LIMIT" })],
    [1, 1, 2, 4, 4, ok({ revision: 2, conflict: false })],
    [2, 1, 2, 4, 4, ok({ revision: 3, conflict: true })],
    [1, 2, 1, 4, 1, err({ code: "INVALID_BASE" })],
    [1, 0, 1, 4, 1, err({ code: "INVALID_BASE" })],
    [1, 1, 1, 1, 5, err({ code: "SIZE_LIMIT" })],
    [1, 1, 1, 6, 3, err({ code: "STORAGE_LIMIT" })],
    [3, 3, 1, 0, 0, err({ code: "VERSION_LIMIT" })],
] as const)(
    "head %i and base %i with %i items, %i retained bytes and %i incoming bytes",
    (head, base, items, storedBytes, versionBytes, expected) => {
        expect(
            decideAppend({ head, base, usage: { items, storedBytes }, versionBytes, limits }),
        ).toEqual(expected);
    },
);
