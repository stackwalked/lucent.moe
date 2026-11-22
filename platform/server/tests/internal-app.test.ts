import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { claimServiceEpoch, openEpochGuard } from "../src/db/epoch-guard.ts";
import { createInternalWebApp } from "../src/listeners/internal/app.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";

test("a superseded process answers internal RPC with 503", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const claimed = await claimServiceEpoch(nativeDb);
        invariant(claimed.ok, `claim failed: ${JSON.stringify(claimed)}`);
        const guard = openEpochGuard({
            db: nativeDb,
            ownEpoch: claimed.value,
            pollIntervalMs: 60_000,
            onReadFailure: () => {},
        });
        await claimServiceEpoch(nativeDb);
        await guard.checkNow();
        guard.close();

        const app = createInternalWebApp({
            catalog: new Map(),
            auth: await createTestAuthDeps(nativeDb, createSeededRng(1)),
            epochGuard: guard,
            webInternalKey: PEER_KEY,
            artifactDir: null,
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
