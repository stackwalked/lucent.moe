import { describe, expect, test } from "bun:test";
import { ok } from "@lucent/core/result";
import { ProductId, RoleId } from "@lucent/core/scalars";
import {
    decideRoles,
    type LinkedStanding,
    type RoleRule,
} from "../src/edge/discord/roles.rules.ts";

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
