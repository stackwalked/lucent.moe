import { expect, test } from "bun:test";
import { invariant } from "../src/core/contain.ts";
import { openEpochGuard } from "../src/db/epoch-guard.ts";
import { type DbFailure, execute, sql } from "../src/db/pool.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

test("the guard marks the process superseded once service.epoch changes", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const guardRes = await openEpochGuard({
            db: nativeDb,
            pollIntervalMs: 60_000,
            onReadFailure: () => {},
        });
        invariant(guardRes.ok, `guard failed to open: ${JSON.stringify(guardRes)}`);
        const guard = guardRes.value;
        await execute(nativeDb, sql`update service set epoch = epoch + 1 where id = true`);
        await guard.checkNow();
        guard.close();
        expect(guard.isSuperseded()).toBe(true);
    });
});

test("a failed epoch read is reported and leaves the process serving", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const failures: DbFailure[] = [];
        const guardRes = await openEpochGuard({
            db: nativeDb,
            pollIntervalMs: 60_000,
            onReadFailure: (failure) => failures.push(failure),
        });
        invariant(guardRes.ok, `guard failed to open: ${JSON.stringify(guardRes)}`);
        const guard = guardRes.value;
        await nativeDb.close();
        await guard.checkNow();
        guard.close();
        expect(guard.isSuperseded()).toBe(false);
        expect(failures.map((failure) => failure.code)).toEqual(["DB_UNAVAILABLE"]);
    });
});
