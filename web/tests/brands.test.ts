import { expect, test } from "bun:test";
import * as brands from "@lucent/core/brands";
import { createSeededRng } from "@lucent/core/rng";
import * as scalars from "@lucent/core/scalars";
import { isAction } from "@lucent/policy/action-list";
import { ActionSchema } from "@lucent/policy/actions";
import { CloudId, ItemKind } from "@lucent/rpc/cloud-item";
import { isCloudId, isItemKind } from "@lucent/rpc/cloud-item-guards";
import { isAccountStatus } from "@lucent/rpc/web/account-status";
import { AccountStatus } from "@lucent/rpc/web/authority";

// The browser checks with plain guards what platform parses with zod: a guard that passes more
// than its schema sends platform what it refuses, one that passes less refuses what it takes.

const id = (prefix: string, length: number, fill = "a") => `${prefix}${fill.repeat(length)}`;

const CANDIDATES: readonly unknown[] = [
    0,
    -0,
    1,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    1e21,
    "1",
    "",
    null,
    undefined,
    {},
    [],
    true,
    id("acc_", 22),
    id("acc_", 22, "-"),
    id("acc_", 21),
    id("acc_", 23),
    `${id("acc_", 22)}\n`,
    `${id("acc_", 21)}*`,
    id("ent_", 22),
    id("ses_", 22),
    id("role_", 1),
    id("role_", 2),
    id("role_", 48),
    id("role_", 49),
    "role_mod",
    "role_Mod-1",
    id("", 15),
    id("", 16),
    id("", 128),
    id("", 129),
    id("op_", 22),
    "cs2",
    "c",
    "-cs",
    "Cs2",
    id("c", 31),
    id("c", 32),
    "alpha",
    "a",
    "1a",
    id("a", 15),
    id("a", 16),
    id("", 42, "A"),
    id("", 43, "A"),
    id("", 44, "A"),
    id("", 43, "="),
    "a.b_c-d",
    ".a",
    id("a", 63),
    id("a", 64),
    "fé",
    "accounts:read",
    "audit:read",
    "accounts:READ",
    "audit:read ",
    "active",
    "setup_pending",
    "Active",
    "config",
    "inventory",
    "script",
    "Config",
    "0",
    "01",
    "999999999999999999",
    "9223372036854775807",
    "9223372036854775808",
    "10000000000000000000",
    "-1",
];

const PAIRS: readonly (readonly [
    string,
    (value: unknown) => boolean,
    { readonly safeParse: (value: unknown) => { readonly success: boolean } },
])[] = [
    ["EpochMs", brands.isEpochMs, scalars.EpochMs],
    ["Seconds", brands.isSeconds, scalars.Seconds],
    ["ServiceEpoch", brands.isServiceEpoch, scalars.ServiceEpoch],
    ["AccountId", brands.isAccountId, scalars.AccountId],
    ["RoleId", brands.isRoleId, scalars.RoleId],
    ["EntitlementId", brands.isEntitlementId, scalars.EntitlementId],
    ["OperationId", brands.isOperationId, scalars.OperationId],
    ["ProductId", brands.isProductId, scalars.ProductId],
    ["ChannelId", brands.isChannelId, scalars.ChannelId],
    ["BearerToken", brands.isBearerToken, scalars.BearerToken],
    ["SessionId", brands.isSessionId, scalars.SessionId],
    ["FeatureTag", brands.isFeatureTag, scalars.FeatureTag],
    ["Action", isAction, ActionSchema],
    ["AccountStatus", isAccountStatus, AccountStatus],
    ["CloudId", isCloudId, CloudId],
    ["ItemKind", isItemKind, ItemKind],
];

test("each browser guard accepts exactly what its zod schema accepts", () => {
    for (const [name, guard, schema] of PAIRS) {
        for (const candidate of CANDIDATES) {
            expect([name, candidate, guard(candidate)]).toEqual([
                name,
                candidate,
                schema.safeParse(candidate).success,
            ]);
        }
    }
});

test("made ids pass their own schemas", () => {
    const rng = createSeededRng(7);
    for (let i = 0; i < 32; i++) {
        expect(scalars.AccountId.safeParse(brands.newAccountId(rng)).success).toBe(true);
        expect(scalars.EntitlementId.safeParse(brands.newEntitlementId(rng)).success).toBe(true);
        expect(scalars.SessionId.safeParse(brands.newSessionId(rng)).success).toBe(true);
        expect(scalars.OperationId.safeParse(brands.newOperationId(rng)).success).toBe(true);
    }
});
