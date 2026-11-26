import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import { CLOUD_LIMITS, decideAppend } from "../src/delivery/cloud/items.rules.ts";
import { type CloudOperation, decideCloudAccess } from "../src/delivery/cloud/member.rules.ts";
import { decideShare, MAX_SHARES_PER_ITEM } from "../src/delivery/cloud/shares.rules.ts";

const limits = { maxItems: 2, maxStoredBytes: 8, maxVersionBytes: 4, maxVersionsPerItem: 3 };
const open = { droppable: null } as const;

test.each([
    [99, 0, 8_339_456, 49_152, ok({ revision: 1, conflict: false, drop: null })],
    [100, 0, 0, 1, err({ code: "ITEM_LIMIT" })],
    [1, 63, 0, 1, ok({ revision: 64, conflict: false, drop: null })],
    [1, 1, 0, 49_153, err({ code: "SIZE_LIMIT" })],
    [1, 1, 8_388_608, 1, err({ code: "STORAGE_LIMIT" })],
] as const)(
    "production storage with %i items, head %i, %i retained bytes and %i incoming bytes",
    (items, head, storedBytes, versionBytes, expected) => {
        expect(
            decideAppend({
                limits: CLOUD_LIMITS,
                usage: { items, storedBytes },
                head,
                versions: head,
                ...open,
                base: head,
                versionBytes,
            }),
        ).toEqual(expected);
    },
);

test.each([
    [0, 0, 1, 4, 4, ok({ revision: 1, conflict: false, drop: null })],
    [0, 0, 2, 4, 1, err({ code: "ITEM_LIMIT" })],
    [1, 1, 2, 4, 4, ok({ revision: 2, conflict: false, drop: null })],
    [2, 1, 2, 4, 4, ok({ revision: 3, conflict: true, drop: null })],
    [1, 2, 1, 4, 1, err({ code: "INVALID_BASE" })],
    [1, 0, 1, 4, 1, err({ code: "INVALID_BASE" })],
    [1, 1, 1, 1, 5, err({ code: "SIZE_LIMIT" })],
    [1, 1, 1, 6, 3, err({ code: "STORAGE_LIMIT" })],
] as const)(
    "head %i and base %i with %i items, %i retained bytes and %i incoming bytes",
    (head, base, items, storedBytes, versionBytes, expected) => {
        expect(
            decideAppend({
                head,
                versions: head,
                ...open,
                base,
                usage: { items, storedBytes },
                versionBytes,
                limits,
            }),
        ).toEqual(expected);
    },
);

// Head 9 holds three versions (the window is three); the oldest unpinned one, if any, is given.
test.each([
    ["has room", 2, null, 6, 2, ok({ revision: 10, conflict: false, drop: null })],
    [
        "drops the oldest",
        3,
        { revision: 7, storedBytes: 2 },
        6,
        2,
        ok({ revision: 10, conflict: false, drop: 7 }),
    ],
    [
        "counts the freed bytes",
        3,
        { revision: 7, storedBytes: 3 },
        8,
        3,
        ok({ revision: 10, conflict: false, drop: 7 }),
    ],
    [
        "still over storage",
        3,
        { revision: 7, storedBytes: 1 },
        8,
        2,
        err({ code: "STORAGE_LIMIT" }),
    ],
    ["every older one pinned", 3, null, 3, 1, err({ code: "VERSION_LIMIT" })],
    [
        "over a lowered window",
        5,
        { revision: 5, storedBytes: 1 },
        5,
        1,
        ok({ revision: 10, conflict: false, drop: 5 }),
    ],
] as const)("a full window %s", (_, versions, droppable, storedBytes, versionBytes, expected) => {
    expect(
        decideAppend({
            head: 9,
            base: 9,
            versions,
            droppable,
            usage: { items: 1, storedBytes },
            versionBytes,
            limits,
        }),
    ).toEqual(expected);
});

test.each([
    [0, ok(undefined)],
    [15, ok(undefined)],
    [16, err({ code: "SHARE_LIMIT" })],
    [17, err({ code: "SHARE_LIMIT" })],
] as const)("an item with %i links can take another: %o", (shares, expected) => {
    expect(decideShare({ shares, maxShares: MAX_SHARES_PER_ITEM })).toEqual(expected);
});

test("production share pins leave a full version window an older version to drop", () => {
    expect(MAX_SHARES_PER_ITEM + 1).toBeLessThan(CLOUD_LIMITS.maxVersionsPerItem);
});

const HELD: readonly CloudOperation[] = ["list", "history", "delete", "revoke"];
const ADDING: readonly CloudOperation[] = ["create", "rename", "restore", "share", "import"];

const ACCESS: readonly (readonly [CloudOperation, boolean, boolean, boolean])[] = [
    ...HELD.flatMap((operation): [CloudOperation, boolean, boolean, boolean][] => [
        [operation, true, true, true],
        [operation, true, false, true],
        [operation, false, true, true],
        [operation, false, false, false],
    ]),
    ...ADDING.flatMap((operation): [CloudOperation, boolean, boolean, boolean][] => [
        [operation, true, true, true],
        [operation, true, false, true],
        [operation, false, true, false],
        [operation, false, false, false],
    ]),
];

test.each(ACCESS)(
    "%s with current eligibility %p and held items %p is allowed: %p",
    (operation, eligible, holdsItems, allowed) => {
        expect(decideCloudAccess({ operation, eligible, holdsItems })).toEqual(
            allowed ? ok(undefined) : err({ code: "NOT_FOUND" }),
        );
    },
);
