import { expect, test } from "bun:test";
import { join } from "node:path";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createRpcClient } from "@lucent/rpc/client";
import { webContract } from "@lucent/rpc/web";
import { TEST_RELYING_PARTY } from "@lucent/testing/authenticator";
import { WORKSPACE_ROOT } from "@lucent/testing/postgres";
import { type RunningServer, startServer } from "../src/boot.ts";
import type { ServerConfig } from "../src/config.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
const silent = { write: () => {} };

function configFor(databaseUrl: string): ServerConfig {
    return {
        databaseUrl,
        internalListen: { kind: "loopback", hostname: "127.0.0.1", port: 0 },
        webInternalKey: PEER_KEY,
        productsDir: join(WORKSPACE_ROOT, "products"),
        totpKeys: [{ kid: "test", raw: new Uint8Array(32) }],
        relyingParty: TEST_RELYING_PARTY,
        passwordOnly: false,
    };
}

function clientFor(server: RunningServer) {
    return createRpcClient(webContract, {
        endpointUrl: `${server.internalAddress}/internal/web/rpc`,
        peerKey: PEER_KEY,
    });
}

test("a server refuses to boot against a database whose schema is not current", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(
        async ({ databaseUrl }) => {
            const started = await startServer({ config: configFor(databaseUrl), logger: silent });
            expect(started.ok).toBe(false);
            expect(!started.ok && started.error.code).toBe("SCHEMA_NOT_CURRENT");
        },
        { template: "empty" },
    );
});

test("a booted server stops answering once a newer instance boots", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ databaseUrl }) => {
        const boot = () =>
            startServer({
                config: configFor(databaseUrl),
                logger: silent,
                epochPollIntervalMs: 20,
            });
        const first = await boot();
        invariant(first.ok, `first boot failed: ${JSON.stringify(first)}`);
        const health = await clientFor(first.value).call("health.check", {});
        expect(health.ok).toBe(true);

        const second = await boot();
        invariant(second.ok, `second boot failed: ${JSON.stringify(second)}`);
        await Bun.sleep(100);
        expect(await clientFor(first.value).call("health.check", {})).toEqual(
            err({ code: "SERVICE_UNAVAILABLE" }),
        );
        expect(await clientFor(second.value).call("health.check", {})).toEqual(
            ok({ productsLoaded: 2 }),
        );

        await first.value.stop();
        await second.value.stop();
    });
});

test("an instance that can't listen leaves the one serving untouched", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ databaseUrl }) => {
        const serving = await startServer({
            config: configFor(databaseUrl),
            logger: silent,
            epochPollIntervalMs: 20,
        });
        invariant(serving.ok, `first boot failed: ${JSON.stringify(serving)}`);
        const port = Number(new URL(serving.value.internalAddress).port);

        const clash = await startServer({
            config: {
                ...configFor(databaseUrl),
                internalListen: { kind: "loopback", hostname: "127.0.0.1", port },
            },
            logger: silent,
        });
        expect(!clash.ok && clash.error.code).toBe("LISTEN_FAILED");
        await Bun.sleep(100);
        expect(await clientFor(serving.value).call("health.check", {})).toEqual(
            ok({ productsLoaded: 2 }),
        );
        await serving.value.stop();
    });
});
