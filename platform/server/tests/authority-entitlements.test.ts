import { describe, expect, test } from "bun:test";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import {
    type AccountId,
    ChannelId,
    EpochMs,
    FeatureTag,
    newOperationId,
    RoleId,
} from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { readEffectiveProductAccess } from "../src/authority/entitlements.ts";
import {
    type EntitlementProductInput,
    issueEntitlement,
    upsertRole,
} from "../src/authority/writers.ts";
import { type Db, execute, sql } from "../src/db/pool.ts";
import {
    catalog,
    grantRole,
    product,
    seedAccount,
    seedRole,
    seedRoot,
    seedStaff,
    steppedUp,
} from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const T0 = EpochMs.parse(1_790_000_000_000);
const T_END = EpochMs.parse(1_800_000_000_000);
const DURING = EpochMs.parse(T0 + 5_000);
const NO_ACCESS = { ok: true, value: { isEntitled: false, features: [], channels: [] } } as const;

async function issue(
    db: Db,
    rng: SeededRng,
    params: {
        readonly caller: Caller;
        readonly target: AccountId;
        readonly products: readonly EntitlementProductInput[];
    },
) {
    return await issueEntitlement({
        db,
        rng,
        catalog: catalog(),
        caller: params.caller,
        operationId: newOperationId(rng),
        targetAccountId: params.target,
        validFrom: T0,
        validUntil: T_END,
        products: params.products,
    });
}

const cs2Stable: EntitlementProductInput = {
    productId: product("cs2").id,
    features: [FeatureTag.parse("aim")],
    channels: [ChannelId.parse("stable")],
};

describe("entitlements and effective product access", () => {
    test("a role channel grant alone gives no product access", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(201);
            const root = await steppedUp(nativeDb, await seedRoot(nativeDb, rng));
            const memberId = await seedAccount(nativeDb, rng, "player@x.test");
            const alpha = RoleId.parse("role_cs2_alpha");
            const role = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: root,
                operationId: newOperationId(rng),
                roleId: alpha,
                name: "CS2 Alpha",
                rank: 1,
                permissions: [],
                channelGrants: [
                    { productId: product("cs2").id, channels: [ChannelId.parse("alpha")] },
                ],
            });
            expect(role.ok).toBe(true);
            await grantRole(nativeDb, { accountId: memberId, roleId: alpha });

            const access = await readEffectiveProductAccess(nativeDb, {
                accountId: memberId,
                product: product("cs2"),
                at: DURING,
            });

            expect(access).toEqual(NO_ACCESS);
        });
    });

    test("entitlements and role channel grants union, with channels in catalog order", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(202);
            const root = await steppedUp(nativeDb, await seedRoot(nativeDb, rng));
            const memberId = await seedAccount(nativeDb, rng, "player@x.test");
            const cs2 = product("cs2");
            const alpha = RoleId.parse("role_cs2_alpha");
            const role = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: root,
                operationId: newOperationId(rng),
                roleId: alpha,
                name: "CS2 Alpha",
                rank: 1,
                permissions: [],
                channelGrants: [{ productId: cs2.id, channels: [ChannelId.parse("alpha")] }],
            });
            expect(role.ok).toBe(true);
            await grantRole(nativeDb, { accountId: memberId, roleId: alpha });
            const first = await issue(nativeDb, rng, {
                caller: root,
                target: memberId,
                products: [
                    cs2Stable,
                    {
                        productId: product("lucent-loader").id,
                        features: "*",
                        channels: [ChannelId.parse("stable")],
                    },
                ],
            });
            expect(first.ok).toBe(true);
            const addOn = await issue(nativeDb, rng, {
                caller: root,
                target: memberId,
                products: [
                    {
                        productId: cs2.id,
                        features: [FeatureTag.parse("visuals"), FeatureTag.parse("movement")],
                        channels: [ChannelId.parse("debug")],
                    },
                ],
            });
            expect(addOn.ok).toBe(true);

            const access = await readEffectiveProductAccess(nativeDb, {
                accountId: memberId,
                product: cs2,
                at: DURING,
            });

            expect(access).toEqual({
                ok: true,
                value: {
                    isEntitled: true,
                    features: ["aim", "movement", "visuals"].map((f) => FeatureTag.parse(f)),
                    channels: ["stable", "alpha", "debug"].map((c) => ChannelId.parse(c)),
                },
            });
        });
    });

    test("product access ends at valid_until", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(203);
            const root = await steppedUp(nativeDb, await seedRoot(nativeDb, rng));
            const memberId = await seedAccount(nativeDb, rng, "player@x.test");
            const issued = await issue(nativeDb, rng, {
                caller: root,
                target: memberId,
                products: [cs2Stable],
            });
            expect(issued.ok).toBe(true);

            const access = await readEffectiveProductAccess(nativeDb, {
                accountId: memberId,
                product: product("cs2"),
                at: T_END,
            });

            expect(access).toEqual(NO_ACCESS);
        });
    });

    test("a suspended entitlement is ignored", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(204);
            const root = await steppedUp(nativeDb, await seedRoot(nativeDb, rng));
            const memberId = await seedAccount(nativeDb, rng, "player@x.test");
            const issued = await issue(nativeDb, rng, {
                caller: root,
                target: memberId,
                products: [cs2Stable],
            });
            expect(issued.ok).toBe(true);
            const suspended = await execute(
                nativeDb,
                sql`update entitlement set status = 'suspended' where account_id = ${memberId}`,
            );
            expect(suspended).toEqual({ ok: true, value: 1 });

            const access = await readEffectiveProductAccess(nativeDb, {
                accountId: memberId,
                product: product("cs2"),
                at: DURING,
            });

            expect(access).toEqual(NO_ACCESS);
        });
    });

    test("a holder of entitlements:issue can license a lower-ranked account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(205);
            const seller = await seedRole(nativeDb, {
                id: "role_seller",
                rank: 10,
                permissions: ["entitlements:issue"],
            });
            const sellerId = await seedStaff(nativeDb, rng, { email: "s@x.test", roleId: seller });
            const memberId = await seedAccount(nativeDb, rng, "player@x.test");

            const res = await issue(nativeDb, rng, {
                caller: await steppedUp(nativeDb, sellerId),
                target: memberId,
                products: [cs2Stable],
            });

            expect(res).toMatchObject({ ok: true, value: { replayed: false } });
        });
    });

    test("a holder of entitlements:issue cannot license their own account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(206);
            const seller = await seedRole(nativeDb, {
                id: "role_seller",
                rank: 10,
                permissions: ["entitlements:issue"],
            });
            const sellerId = await seedStaff(nativeDb, rng, { email: "s@x.test", roleId: seller });

            const res = await issue(nativeDb, rng, {
                caller: await steppedUp(nativeDb, sellerId),
                target: sellerId,
                products: [cs2Stable],
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("no caller can license the root account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(207);
            const rootId = await seedRoot(nativeDb, rng);
            const seller = await seedRole(nativeDb, {
                id: "role_seller",
                rank: 1_000,
                permissions: ["entitlements:issue"],
            });
            const sellerId = await seedStaff(nativeDb, rng, { email: "s@x.test", roleId: seller });

            const res = await issue(nativeDb, rng, {
                caller: await steppedUp(nativeDb, sellerId),
                target: rootId,
                products: [cs2Stable],
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });
});
