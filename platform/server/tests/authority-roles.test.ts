import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { STEP_UP_WINDOW_SECONDS } from "../src/authority/policy.ts";
import { readRole } from "../src/authority/standing.ts";
import { assignAccountRole, upsertRole } from "../src/authority/writers.ts";
import { createSeededRng } from "../src/core/rng.ts";
import { EpochMs, newOperationId, RoleId } from "../src/core/scalars.ts";
import { sql } from "../src/db/pool.ts";
import {
    catalog,
    dbNow,
    grantRole,
    scalar,
    seedAccount,
    seedRole,
    seedRoot,
    seedStaff,
    steppedUp,
} from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const MANAGER_PERMISSIONS = ["roles:manage", "roles:assign", "accounts:suspend"];

describe("role authoring and assignment", () => {
    test("a caller cannot rewrite a role that outranks them, even to lower it", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(1);
            const admin = await seedRole(nativeDb, {
                id: "role_admin",
                rank: 100,
                permissions: [],
            });
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: await steppedUp(nativeDb, callerId),
                operationId: newOperationId(rng),
                roleId: admin,
                name: "role_admin",
                rank: 10,
                permissions: [],
                channelGrants: [],
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
            expect(await readRole(nativeDb, admin)).toMatchObject({
                ok: true,
                value: { rank: 100 },
            });
        });
    });

    test("a caller cannot create a role at their own rank", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(2);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: await steppedUp(nativeDb, callerId),
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_peer"),
                name: "Peer",
                rank: 50,
                permissions: [],
                channelGrants: [],
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a caller can create a role below their rank carrying permissions they hold", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(3);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: await steppedUp(nativeDb, callerId),
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_mod"),
                name: "Moderator",
                rank: 49,
                permissions: ["accounts:suspend"],
                channelGrants: [],
            });

            expect(res).toEqual({
                ok: true,
                value: { roleId: RoleId.parse("role_mod"), replayed: false },
            });
        });
    });

    test("a caller cannot put a permission they lack into a role", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(4);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: await steppedUp(nativeDb, callerId),
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_mod"),
                name: "Moderator",
                rank: 10,
                permissions: ["accounts:suspend", "entitlements:issue"],
                channelGrants: [],
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a caller cannot assign a role to their own account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(5);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const helper = await seedRole(nativeDb, {
                id: "role_helper",
                rank: 10,
                permissions: [],
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });

            const res = await assignAccountRole({
                db: nativeDb,
                caller: await steppedUp(nativeDb, callerId),
                targetAccountId: callerId,
                roleId: helper,
                expiresAt: null,
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a caller cannot grant a role at their own rank", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(6);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });
            const memberId = await seedAccount(nativeDb, rng, "member@x.test");

            const res = await assignAccountRole({
                db: nativeDb,
                caller: await steppedUp(nativeDb, callerId),
                targetAccountId: memberId,
                roleId: manager,
                expiresAt: null,
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a caller cannot grant a lower role that carries a permission they lack", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(7);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const issuer = await seedRole(nativeDb, {
                id: "role_issuer",
                rank: 10,
                permissions: ["entitlements:issue"],
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });
            const memberId = await seedAccount(nativeDb, rng, "member@x.test");

            const res = await assignAccountRole({
                db: nativeDb,
                caller: await steppedUp(nativeDb, callerId),
                targetAccountId: memberId,
                roleId: issuer,
                expiresAt: null,
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a suspended caller is refused despite holding the permission", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(8);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });
            const caller = await steppedUp(nativeDb, callerId);
            expect(
                await scalar(
                    nativeDb,
                    z.string(),
                    sql`update account set status = 'suspended' where id = ${callerId} returning status as value`,
                ),
            ).toBe("suspended");

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller,
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_mod"),
                name: "Moderator",
                rank: 10,
                permissions: [],
                channelGrants: [],
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a caller whose only role has expired is refused", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(9);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedAccount(nativeDb, rng, "m@x.test");
            const now = await dbNow(nativeDb);
            await grantRole(nativeDb, {
                accountId: callerId,
                roleId: manager,
                expiresAt: EpochMs.parse(now - 1_000),
            });

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: { accountId: callerId, stepUpAt: now },
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_mod"),
                name: "Moderator",
                rank: 10,
                permissions: [],
                channelGrants: [],
            });

            expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        });
    });

    test("a sensitive action without a step-up is refused with STEP_UP_REQUIRED", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(10);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: { accountId: callerId, stepUpAt: null },
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_mod"),
                name: "Moderator",
                rank: 10,
                permissions: [],
                channelGrants: [],
            });

            expect(res).toEqual({
                ok: false,
                error: { code: "STEP_UP_REQUIRED", withinSeconds: STEP_UP_WINDOW_SECONDS },
            });
        });
    });

    test("a step-up older than 30 minutes is refused with STEP_UP_REQUIRED", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(11);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: MANAGER_PERMISSIONS,
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: manager });
            const now = await dbNow(nativeDb);

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: {
                    accountId: callerId,
                    stepUpAt: EpochMs.parse(now - STEP_UP_WINDOW_SECONDS * 1_000 - 1),
                },
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_mod"),
                name: "Moderator",
                rank: 10,
                permissions: [],
                channelGrants: [],
            });

            expect(res).toEqual({
                ok: false,
                error: { code: "STEP_UP_REQUIRED", withinSeconds: STEP_UP_WINDOW_SECONDS },
            });
        });
    });

    test("a stored permission that is no longer an Action grants nothing and is reported", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(12);
            const legacy = await seedRole(nativeDb, {
                id: "role_legacy",
                rank: 50,
                permissions: ["roles:manage", "billing:refund"],
            });
            const callerId = await seedStaff(nativeDb, rng, { email: "m@x.test", roleId: legacy });

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: await steppedUp(nativeDb, callerId),
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_mod"),
                name: "Moderator",
                rank: 10,
                permissions: [],
                channelGrants: [],
            });

            expect(res.ok).toBe(true);
            expect(await readRole(nativeDb, legacy)).toMatchObject({
                ok: true,
                value: { permissions: ["roles:manage"], unknownPermissions: ["billing:refund"] },
            });
        });
    });

    test("the role audit row records the role before and after the change", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(13);
            const rootId = await seedRoot(nativeDb, rng);
            const mod = await seedRole(nativeDb, {
                id: "role_mod",
                rank: 10,
                permissions: ["accounts:suspend"],
            });

            const res = await upsertRole({
                db: nativeDb,
                catalog: catalog(),
                caller: await steppedUp(nativeDb, rootId),
                operationId: newOperationId(rng),
                roleId: mod,
                name: "role_mod",
                rank: 10,
                permissions: ["tickets:reply"],
                channelGrants: [],
            });
            expect(res.ok).toBe(true);

            const target = await scalar(
                nativeDb,
                z.unknown(),
                sql`select target as value from audit where operation = 'role.upsert'`,
            );
            expect(target).toEqual({
                roleId: "role_mod",
                before: {
                    name: "role_mod",
                    rank: 10,
                    permissions: ["accounts:suspend"],
                    channelGrants: [],
                },
                after: {
                    name: "role_mod",
                    rank: 10,
                    permissions: ["tickets:reply"],
                    channelGrants: [],
                },
            });
        });
    });
});
