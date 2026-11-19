import { join } from "node:path";
import { invariant } from "@lucent/core/contain";
import { toHex } from "@lucent/core/scalars";
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

// The range API's answer for a prefix: the listed passwords' suffixes with a count, as Have I
// Been Pwned answers, so tests never reach the real one.
async function servePwnedRanges(breached: readonly string[]): Promise<{
    readonly url: string;
    readonly stop: () => Promise<void>;
}> {
    const hashes = await Promise.all(
        breached.map(async (password) =>
            toHex(
                new Uint8Array(
                    await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password)),
                ),
            ).toUpperCase(),
        ),
    );
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req) => {
            const prefix = new URL(req.url).pathname.split("/").at(-1) ?? "";
            const lines = hashes
                .filter((hash) => hash.startsWith(prefix))
                .map((hash) => `${hash.slice(5)}:7`);
            return new Response(lines.join("\r\n"));
        },
    });
    return { url: `http://127.0.0.1:${server.port}/range/`, stop: () => server.stop() };
}

const Bootstrapped = z.object({ setupPath: z.string().startsWith("/setup/") });

// Platform as an operator brings it up: a fresh database, `ops migrate`, `ops
// bootstrap-superadmin`, then the server's own entry. Nothing is imported from it, so what's under
// test is the program that ships, configured through its environment. Its browsers come from
// `webOrigin`.
export async function startPlatform(params: {
    readonly cluster: EphemeralCluster;
    readonly database: string;
    readonly webOrigin: string;
    // Passwords the stand-in for Have I Been Pwned's range API lists as breached.
    readonly breached?: readonly string[];
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

    const range = await servePwnedRanges(params.breached ?? []);
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
            LUCENT_PWNED_PASSWORDS_URL: range.url,
        },
    });
    await server.waitFor(/"msg":"listening"/);
    return {
        internalUrl: `http://127.0.0.1:${port}`,
        peerKey: PEER_KEY,
        databaseUrl,
        rootSetupPath: bootstrapped.data.setupPath,
        stop: async () => {
            await server.stop();
            await range.stop();
        },
    };
}
