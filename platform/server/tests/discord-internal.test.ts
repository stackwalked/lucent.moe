import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { DISCORD_RPC_PATH } from "@lucent/rpc/discord/contract";
import { claimServiceEpoch, openEpochGuard } from "../src/db/epoch-guard.ts";
import { createInternalWebApp, routeInternal } from "../src/listeners/internal/app.ts";
import { createInternalDiscordApp } from "../src/listeners/internal/discord.ts";
import { catalog } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const WEB_KEY = "test-web-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
const DISCORD_KEY = "test-discord-peer-key-0123456789abcdefghijklmnopqrstuvw";

test("the connector's key reaches only the discord procedures", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const claimed = await claimServiceEpoch(nativeDb);
        invariant(claimed.ok, "epoch claimed");
        const epochGuard = openEpochGuard({
            db: nativeDb,
            ownEpoch: claimed.value,
            pollIntervalMs: 60_000,
            onReadFailure: () => {},
        });
        const logger = { write: () => {} };
        const serve = routeInternal({
            web: createInternalWebApp({
                catalog: catalog(),
                auth: await createTestAuthDeps(nativeDb, createSeededRng(1)),
                epochGuard,
                webInternalKey: WEB_KEY,
                artifactDir: null,
                logger,
            }).fetch,
            discord: createInternalDiscordApp({
                db: nativeDb,
                catalog: catalog(),
                siteOrigin: "https://lucent.test",
                epochGuard,
                discordInternalKey: DISCORD_KEY,
                logger,
            }).fetch,
        });
        const call = async (path: string, key: string, procedure: string) => {
            const res = await serve(
                new Request(`http://localhost${path}`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                    body: JSON.stringify({ procedure, input: {} }),
                }),
            );
            return { status: res.status, body: await res.json() };
        };

        expect(await call("/internal/web/rpc", DISCORD_KEY, "health.check")).toEqual({
            status: 401,
            body: err({ code: "AUTH_REQUIRED" }),
        });
        expect(await call(DISCORD_RPC_PATH, DISCORD_KEY, "health.check")).toEqual({
            status: 404,
            body: err({ code: "UNKNOWN_PROCEDURE" }),
        });
        expect(await call(DISCORD_RPC_PATH, WEB_KEY, "rules.read")).toEqual({
            status: 401,
            body: err({ code: "AUTH_REQUIRED" }),
        });
        expect(await call(DISCORD_RPC_PATH, DISCORD_KEY, "rules.read")).toMatchObject({
            status: 200,
            body: { ok: true, value: { siteOrigin: "https://lucent.test", managedRoleIds: [] } },
        });
        expect((await call("/internal/web/rpc", WEB_KEY, "health.check")).status).toBe(200);
        epochGuard.close();
    });
});
