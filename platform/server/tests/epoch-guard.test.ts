import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { claimServiceEpoch, openEpochGuard } from "../src/base/db/epoch-guard.ts";
import type { DbFailure } from "../src/base/db/pool.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

test("an instance is superseded once a later instance claims the next epoch", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const first = await claimServiceEpoch(nativeDb);
        invariant(first.ok, `claim failed: ${JSON.stringify(first)}`);
        const guard = openEpochGuard({
            db: nativeDb,
            ownEpoch: first.value,
            pollIntervalMs: 60_000,
            onReadFailure: () => {},
        });
        const isSupersededAlone = await guard.checkNow();

        const second = await claimServiceEpoch(nativeDb);
        const isSupersededAfter = await guard.checkNow();
        guard.close();

        expect(second.ok && second.value > first.value).toBe(true);
        expect(isSupersededAlone).toBe(false);
        expect(isSupersededAfter).toBe(true);
    });
});

test("a failed epoch read is reported and leaves the process serving", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const claimed = await claimServiceEpoch(nativeDb);
        invariant(claimed.ok, `claim failed: ${JSON.stringify(claimed)}`);
        const failures: DbFailure[] = [];
        const guard = openEpochGuard({
            db: nativeDb,
            ownEpoch: claimed.value,
            pollIntervalMs: 60_000,
            onReadFailure: (failure) => failures.push(failure),
        });
        await nativeDb.close();
        await guard.checkNow();
        guard.close();

        expect(guard.isSuperseded()).toBe(false);
        expect(failures.map((failure) => failure.code)).toEqual(["DB_UNAVAILABLE"]);
    });
});
