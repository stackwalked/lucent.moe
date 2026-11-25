import { expect, test } from "bun:test";
import { AccountId } from "@lucent/core/scalars";
import { decideStanding } from "../src/authority/standing.rules.ts";

test.each([
    ["active", false, [], true, 0, []],
    ["suspended", false, [{ rank: 4, permissions: ["obsolete"] }], false, 4, []],
    [
        "active",
        true,
        [
            { rank: 3, permissions: ["audit:read", "obsolete"] },
            { rank: 1, permissions: ["audit:read", "accounts:read"] },
        ],
        false,
        3,
        ["audit:read", "accounts:read"],
    ],
] as const)(
    "standing folds held roles for a %s account (locked: %s)",
    (status, is_locked, roles, isActive, maxRank, permissions) => {
        const accountId = AccountId.parse(`acc_${"a".repeat(22)}`);
        expect(
            decideStanding({
                accountId,
                account: { status, is_locked, is_root: true, is_deleted: false },
                roles,
            }),
        ).toEqual({
            ok: true,
            value: {
                accountId,
                isRoot: true,
                isActive,
                maxRank,
                permissions: new Set(permissions),
            },
        });
    },
);

test("a deleted account is never active, whatever its status says", () => {
    const accountId = AccountId.parse(`acc_${"b".repeat(22)}`);
    const decided = decideStanding({
        accountId,
        account: { status: "active", is_locked: false, is_root: false, is_deleted: true },
        roles: [],
    });
    expect(decided.ok && decided.value.isActive).toBe(false);
});
