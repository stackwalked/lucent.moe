import { join } from "node:path";
import { invariant } from "@lucent/core/contain";
import { z } from "zod";
import { allocateEphemeralPort, type EphemeralCluster, WORKSPACE_ROOT } from "./postgres.ts";
import { runToEnd, spawnServer } from "./process.ts";

const SERVER_DIR = join(WORKSPACE_ROOT, "platform/server");

// Published here and nowhere else; the platform under test accepts them because its WebAuthn
// origin is a localhost one, like the dev values.
const PEER_KEY = "integration-test-peer-key-not-a-secret-0123456789";
const TOTP_KEYS = `it:${"B".repeat(43)}`;

export type RunningPlatform = {
    readonly internalUrl: string;
    readonly peerKey: string;
    readonly databaseUrl: string;
    // Where root's setup link points, as `ops bootstrap-superadmin` printed it.
    readonly rootSetupPath: string;
    readonly stop: () => Promise<void>;
};

const Bootstrapped = z.object({ setupPath: z.string().startsWith("/setup/") });

// Platform as an operator brings it up: a fresh database, `ops migrate`, `ops
// bootstrap-superadmin`, then the server's own entry. Nothing is imported from it, so what's under
// test is the program that ships, configured through its environment. Its browsers come from
// `webOrigin`.
export async function startPlatform(params: {
    readonly cluster: EphemeralCluster;
    readonly database: string;
    readonly webOrigin: string;
}): Promise<RunningPlatform> {
    const databaseUrl = await params.cluster.createDatabase(params.database, "template0");
    const ops = (args: readonly string[]) =>
        runToEnd({
            command: [process.execPath, "src/ops.ts", ...args],
            cwd: SERVER_DIR,
            env: { LUCENT_DATABASE_URL: databaseUrl },
        });
    await ops(["migrate"]);
    const bootstrapped = Bootstrapped.safeParse(
        JSON.parse(
            (
                await ops([
                    "bootstrap-superadmin",
                    "--email",
                    "root@lucent.test",
                    "--username",
                    "root",
                ])
            ).stdout,
        ),
    );
    invariant(bootstrapped.success, "bootstrap-superadmin printed a setup path");

    const port = allocateEphemeralPort();
    const server = spawnServer({
        command: [process.execPath, "src/main.ts"],
        cwd: SERVER_DIR,
        env: {
            LUCENT_DATABASE_URL: databaseUrl,
            LUCENT_INTERNAL_LISTEN: `127.0.0.1:${port}`,
            LUCENT_WEB_INTERNAL_KEY: PEER_KEY,
            LUCENT_PRODUCTS_DIR: join(WORKSPACE_ROOT, "products"),
            LUCENT_TOTP_KEYS: TOTP_KEYS,
            LUCENT_WEBAUTHN_RP_ID: new URL(params.webOrigin).hostname,
            LUCENT_WEBAUTHN_ORIGIN: params.webOrigin,
        },
    });
    await server.waitFor(/"msg":"listening"/);
    return {
        internalUrl: `http://127.0.0.1:${port}`,
        peerKey: PEER_KEY,
        databaseUrl,
        rootSetupPath: bootstrapped.data.setupPath,
        stop: server.stop,
    };
}
