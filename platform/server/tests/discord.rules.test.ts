import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, ProductId, RoleId } from "@lucent/core/scalars";
import {
    decideIssueCode,
    decideRedeem,
    type GatheredRedeem,
    LINK_CODE_TTL_MS,
    type LinkRefusal,
} from "../src/discord/links.rules.ts";
import { decideRoles, type LinkedStanding, type RoleRule } from "../src/discord/roles.rules.ts";

const MEMBERS = "100000000000000001";
const CS2_ROLE = "100000000000000002";
const LOADER_ROLE = "100000000000000003";
const STAFF_ROLE = "100000000000000004";

const RULES: readonly RoleRule[] = [
    { roleId: MEMBERS, condition: { kind: "linked" } },
    { roleId: CS2_ROLE, condition: { kind: "entitled", productId: ProductId.parse("cs2") } },
    {
        roleId: LOADER_ROLE,
        condition: { kind: "entitled", productId: ProductId.parse("lucent-loader") },
    },
    { roleId: STAFF_ROLE, condition: { kind: "holds_role", roleId: RoleId.parse("role_support") } },
    { roleId: CS2_ROLE, condition: { kind: "holds_role", roleId: RoleId.parse("role_tester") } },
];

function standing(params: {
    readonly active?: boolean;
    readonly products?: readonly string[];
    readonly roles?: readonly string[];
}): LinkedStanding {
    return {
        active: params.active ?? true,
        entitledProducts: new Set(params.products ?? []),
        siteRoles: new Set(params.roles ?? []),
    };
}

describe("decideRoles", () => {
    const cases: readonly [string, LinkedStanding | null, readonly string[]][] = [
        ["an unlinked user gets nothing", null, []],
        ["a linked account with nothing gets the linked role", standing({}), [MEMBERS]],
        [
            "an entitlement gives its product's role",
            standing({ products: ["cs2"] }),
            [MEMBERS, CS2_ROLE],
        ],
        [
            "two rules giving one role give it once",
            standing({ products: ["cs2"], roles: ["role_tester"] }),
            [MEMBERS, CS2_ROLE],
        ],
        [
            "a site role gives its Discord role",
            standing({ roles: ["role_support"] }),
            [MEMBERS, STAFF_ROLE],
        ],
        [
            "every condition met gives every role, sorted",
            standing({ products: ["lucent-loader", "cs2"], roles: ["role_support"] }),
            [MEMBERS, CS2_ROLE, LOADER_ROLE, STAFF_ROLE].sort(),
        ],
        [
            "a suspended or locked account gets nothing, whatever it holds",
            standing({ active: false, products: ["cs2"], roles: ["role_support"] }),
            [],
        ],
        [
            "a product no rule names gives nothing more",
            standing({ products: ["other"] }),
            [MEMBERS],
        ],
    ];
    for (const [name, given, roles] of cases) {
        test(name, () => {
            expect(decideRoles(RULES, given)).toEqual(ok(roles));
        });
    }

    test("with no rules nobody gets a role", () => {
        expect(decideRoles([], standing({ products: ["cs2"] }))).toEqual(ok([]));
    });
});

const NOW = EpochMs.parse(1_800_000_000_000);
const LIVE = { expiresAt: EpochMs.parse(NOW + 1), usedAt: null };
const USED_AT = NOW;

describe("decideRedeem", () => {
    const good: GatheredRedeem = {
        txNow: NOW,
        code: LIVE,
        accountActive: true,
        accountLinked: false,
        userLinked: false,
    };
    const cases: readonly [string, Partial<GatheredRedeem>, Result<"link", LinkRefusal>][] = [
        ["a live code links", {}, ok("link")],
        ["an unknown code is refused", { code: null }, err({ code: "CODE_INVALID" })],
        [
            "a code at its expiry is refused",
            { code: { expiresAt: NOW, usedAt: null } },
            err({ code: "CODE_INVALID" }),
        ],
        [
            "a used code is refused",
            { code: { expiresAt: LIVE.expiresAt, usedAt: USED_AT } },
            err({ code: "CODE_INVALID" }),
        ],
        [
            "a suspended account's code is refused like an unknown one",
            { accountActive: false, accountLinked: true },
            err({ code: "CODE_INVALID" }),
        ],
        [
            "a Discord user already linked is refused",
            { userLinked: true },
            err({ code: "ALREADY_LINKED" }),
        ],
        [
            "an account already linked is refused",
            { accountLinked: true },
            err({ code: "ALREADY_LINKED" }),
        ],
        [
            "an expired code says nothing about links",
            { code: { expiresAt: NOW, usedAt: null }, userLinked: true },
            err({ code: "CODE_INVALID" }),
        ],
    ];
    for (const [name, change, expected] of cases) {
        test(name, () => {
            expect(decideRedeem({ ...good, ...change })).toEqual(expected);
        });
    }
});

describe("decideIssueCode", () => {
    test("a code lasts ten minutes from the transaction", () => {
        expect(decideIssueCode({ txNow: NOW, linked: false })).toEqual(
            ok({ expiresAt: EpochMs.parse(NOW + LINK_CODE_TTL_MS) }),
        );
        expect(LINK_CODE_TTL_MS).toBe(600_000);
    });

    test("a linked account gets no code", () => {
        expect(decideIssueCode({ txNow: NOW, linked: true })).toEqual(
            err({ code: "ALREADY_LINKED" }),
        );
    });
});
