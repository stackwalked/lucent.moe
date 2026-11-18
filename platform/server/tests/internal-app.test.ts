import { expect, test } from "bun:test";
import { invariant } from "../src/core/contain.ts";
import { err } from "../src/core/result.ts";
import { openEpochGuard } from "../src/db/epoch-guard.ts";
import { execute, sql } from "../src/db/pool.ts";
import { createInternalWebApp } from "../src/internal/app.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";

test("a superseded process answers internal RPC with 503", async () => {
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

        const app = createInternalWebApp({
            catalog: new Map(),
            epochGuard: guard,
            webInternalKey: PEER_KEY,
            logger: { write: () => {} },
        });
        const res = await app.fetch(
            new Request("http://localhost/internal/web/rpc", {
                method: "POST",
                headers: {
                    authorization: `Bearer ${PEER_KEY}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ procedure: "health.check", input: {} }),
            }),
        );
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual(err({ code: "SERVICE_UNAVAILABLE" }));
    });
});
