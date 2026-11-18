import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { readEffectiveProductAccess } from "../src/authority/entitlements.ts";
import {
    assignAccountRole,
    bootstrapRootAccount,
    issueEntitlement,
    suspendAccount,
} from "../src/authority/writers.ts";
import { createSeededRng } from "../src/core/rng.ts";
import { ChannelId, EpochMs, newOperationId } from "../src/core/scalars.ts";
import { execute, sql } from "../src/db/pool.ts";
import {
    catalog,
    product,
    scalar,
    seedAccount,
    seedRole,
    seedRoot,
    seedStaff,
    steppedUp,
} from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const ADMIN_PERMISSIONS = ["accounts:suspend", "roles:assign"];

describe("accounts and the root account", () => {
    test("only one root account can be bootstrapped", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(101);
            await seedRoot(nativeDb, rng);

            const second = await bootstrapRootAccount({
                db: nativeDb,
                rng,
                email: "second@lucent.test",
                username: "second",
            });

            expect(second).toEqual({ ok: false, error: { code: "ROOT_ALREADY_EXISTS" } });
        });
    });

    test("rerunning the root bootstrap with the same email reports the existing root", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(103);
            const first = { db: nativeDb, rng, email: "root@lucent.test", username: "rootuser" };
            expect((await bootstrapRootAccount(first)).ok).toBe(true);

            expect(await bootstrapRootAccount(first)).toEqual({
                ok: false,
                error: { code: "ROOT_ALREADY_EXISTS" },
            });
        });
    });

    test("the database refuses to suspend or lock the root account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rootId = await seedRoot(nativeDb, createSeededRng(102));

            const suspend = await execute(
                nativeDb,
                sql`update account set status = 'suspended' where id = ${rootId}`,
            );
            const lock = await execute(
                nativeDb,
                sql`update account set is_locked = true where id = ${rootId}`,
            );

            const refused = {
                ok: false,
                error: { code: "CHECK_VIOLATION", constraint: "account_root_inviolable" },
            } as const;
            expect(suspend).toEqual(refused);
            expect(lock).toEqual(refused);
        });
    });

    test("the database refuses to demote the root account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rootId = await seedRoot(nativeDb, createSeededRng(103));

            const demote = await execute(
                nativeDb,
                sql`update account set is_root = false where id = ${rootId}`,
            );

            expect(demote).toEqual({
                ok: false,
                error: { code: "CHECK_VIOLATION", constraint: "account_root_permanent" },
            });
        });
    });

    test("no caller can suspend the root account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(104);
            const rootId = await seedRoot(nativeDb, rng);
            const admin = await seedRole(nativeDb, {
                id: "role_admin",
                rank: 1_000,
                permissions: ADMIN_PERMISSIONS,
            });
            const adminId = await seedStaff(nativeDb, rng, { email: "a@x.test", roleId: admin });

            const res = await suspendAccount({
                db: nativeDb,
                caller: await steppedUp(nativeDb, adminId),
                operationId: newOperationId(rng),
                targetAccountId: rootId,
                reason: "coup",
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("no caller can assign a role to the root account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(105);
            const rootId = await seedRoot(nativeDb, rng);
            const admin = await seedRole(nativeDb, {
                id: "role_admin",
                rank: 1_000,
                permissions: ADMIN_PERMISSIONS,
            });
            const helper = await seedRole(nativeDb, {
                id: "role_helper",
                rank: 1,
                permissions: [],
            });
            const adminId = await seedStaff(nativeDb, rng, { email: "a@x.test", roleId: admin });

            const res = await assignAccountRole({
                db: nativeDb,
                caller: await steppedUp(nativeDb, adminId),
                targetAccountId: rootId,
                roleId: helper,
                expiresAt: null,
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a caller cannot suspend an account of equal rank", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(106);
            const admin = await seedRole(nativeDb, {
                id: "role_admin",
                rank: 100,
                permissions: ADMIN_PERMISSIONS,
            });
            const adminA = await seedStaff(nativeDb, rng, { email: "a@x.test", roleId: admin });
            const adminB = await seedStaff(nativeDb, rng, { email: "b@x.test", roleId: admin });

            const res = await suspendAccount({
                db: nativeDb,
                caller: await steppedUp(nativeDb, adminA),
                operationId: newOperationId(rng),
                targetAccountId: adminB,
                reason: "peer",
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a caller can suspend an account of lower rank", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(107);
            const admin = await seedRole(nativeDb, {
                id: "role_admin",
                rank: 100,
                permissions: ADMIN_PERMISSIONS,
            });
            const mod = await seedRole(nativeDb, { id: "role_mod", rank: 50, permissions: [] });
            const adminId = await seedStaff(nativeDb, rng, { email: "a@x.test", roleId: admin });
            const modId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: mod });

            const res = await suspendAccount({
                db: nativeDb,
                caller: await steppedUp(nativeDb, adminId),
                operationId: newOperationId(rng),
                targetAccountId: modId,
                reason: "policy violation",
            });

            expect(res).toEqual({ ok: true, value: { replayed: false } });
            expect(
                await scalar(
                    nativeDb,
                    z.string(),
                    sql`select status as value from account where id = ${modId}`,
                ),
            ).toBe("suspended");
        });
    });

    test("suspending an account removes its product access inside the entitlement window", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(108);
            const rootId = await seedRoot(nativeDb, rng);
            const memberId = await seedAccount(nativeDb, rng, "player@x.test");
            const root = await steppedUp(nativeDb, rootId);
            const cs2 = product("cs2");
            const t0 = EpochMs.parse(1_790_000_000_000);
            const issued = await issueEntitlement({
                db: nativeDb,
                rng,
                catalog: catalog(),
                caller: root,
                operationId: newOperationId(rng),
                targetAccountId: memberId,
                validFrom: t0,
                validUntil: null,
                products: [
                    { productId: cs2.id, features: "*", channels: [ChannelId.parse("stable")] },
                ],
            });
            expect(issued.ok).toBe(true);

            const suspended = await suspendAccount({
                db: nativeDb,
                caller: root,
                operationId: newOperationId(rng),
                targetAccountId: memberId,
                reason: "chargeback",
            });
            expect(suspended).toEqual({ ok: true, value: { replayed: false } });

            const access = await readEffectiveProductAccess(nativeDb, {
                accountId: memberId,
                product: cs2,
                at: EpochMs.parse(t0 + 5_000),
            });
            expect(access).toEqual({
                ok: true,
                value: { isEntitled: false, features: [], channels: [] },
            });
        });
    });
});
