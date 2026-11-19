import { describe, expect, test } from "bun:test";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId, RoleId } from "@lucent/core/scalars";
import { z } from "zod";
import { suspendAccount, upsertRole } from "../src/authority/writers.ts";
import { execute, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import {
    catalog,
    scalar,
    seedAccount,
    seedRoot,
    steppedUp,
    waitForLockWaiters,
} from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

describe("operation receipts", () => {
    test("a retried operation returns the first outcome with replayed true", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(301);
            const root = await steppedUp(nativeDb, await seedRoot(nativeDb, rng));
            const memberId = await seedAccount(nativeDb, rng, "member@x.test");
            const request = {
                db: nativeDb,
                caller: root,
                operationId: newOperationId(rng),
                targetAccountId: memberId,
                reason: "policy violation",
            };
            expect(await suspendAccount(request)).toEqual({ ok: true, value: { replayed: false } });

            const retried = await suspendAccount(request);

            expect(retried).toEqual({ ok: true, value: { replayed: true } });
        });
    });

    test("a retried operation with a different payload is refused with IDEMPOTENCY_CONFLICT", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(302);
            const root = await steppedUp(nativeDb, await seedRoot(nativeDb, rng));
            const memberId = await seedAccount(nativeDb, rng, "member@x.test");
            const request = {
                db: nativeDb,
                caller: root,
                operationId: newOperationId(rng),
                targetAccountId: memberId,
                reason: "policy violation",
            };
            expect(await suspendAccount(request)).toEqual({ ok: true, value: { replayed: false } });

            const mutated = await suspendAccount({ ...request, reason: "something else" });

            expect(mutated).toEqual({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
        });
    });

    test("two concurrent calls with one operation id write once and the loser replays", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(303);
            const rootId = await seedRoot(nativeDb, rng);
            const request = {
                db: nativeDb,
                catalog: catalog(),
                caller: await steppedUp(nativeDb, rootId),
                operationId: newOperationId(rng),
                roleId: RoleId.parse("role_mod"),
                name: "Moderator",
                rank: 10,
                permissions: [],
                channelGrants: [],
            };

            let racing: ReturnType<typeof upsertRole>[] = [];
            let parked = false;
            const gate = await withTx(nativeDb, async (tx) => {
                const held = await execute(
                    tx,
                    sql`select id from account where id = ${rootId} for update`,
                );
                expect(held).toEqual({ ok: true, value: 1 });
                racing = [upsertRole(request), upsertRole(request)];
                parked = await waitForLockWaiters(nativeDb, 2);
                return ok(undefined);
            });
            const outcomes = await Promise.all(racing);

            expect(gate.ok).toBe(true);
            expect(parked).toBe(true);
            const replayed = outcomes.map((o) => (o.ok ? o.value.replayed : o.error.code));
            expect(replayed.sort()).toEqual([false, true]);
            expect(
                await scalar(
                    nativeDb,
                    z.coerce.number(),
                    sql`select count(*) as value from audit where operation = 'role.upsert'`,
                ),
            ).toBe(1);
        });
    });
});
