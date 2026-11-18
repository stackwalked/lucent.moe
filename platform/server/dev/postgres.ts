import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ignoreErrorsSync, invariant } from "../src/core/contain.ts";
import { execute, openPool, queryOne, sql } from "../src/db/pool.ts";

export const WORKSPACE_ROOT = join(import.meta.dir, "../../..");

// The binaries proto installed for `.prototools`' pin, never PATH: proto's shim there runs postgres
// as a grandchild that outlives this process (holding its output open), and a system install
// would silently stand in for the pinned version.
export function resolvePgBinary(name: "initdb" | "postgres" | "pg_ctl"): string {
    const pins = readFileSync(join(WORKSPACE_ROOT, ".prototools"), "utf8");
    const version = /^postgresql = "([^"]+)"$/m.exec(pins)?.[1];
    invariant(version !== undefined, ".prototools pins no postgresql version");
    const suffix = process.platform === "win32" ? ".exe" : "";
    const binary = join(
        homedir(),
        ".proto",
        "tools",
        "postgresql",
        version,
        "bin",
        `${name}${suffix}`,
    );
    invariant(existsSync(binary), `${binary} is missing; run \`proto install\` in the repo root`);
    return binary;
}

const DEV_DATA_DIR = join(WORKSPACE_ROOT, ".moon/cache/dev/pg");
const DEV_PORT = 4719;
const DEV_DATABASE = "lucent";

export const DEV_DATABASE_URL = `postgres://postgres@127.0.0.1:${DEV_PORT}/${DEV_DATABASE}`;
const ADMIN_URL = `postgres://postgres@127.0.0.1:${DEV_PORT}/postgres`;

async function answers(url: string, attempts: number): Promise<boolean> {
    const pool = openPool({ databaseUrl: url, maxConnections: 1, allowExitOnIdle: true });
    for (let attempt = 0; attempt < attempts; attempt++) {
        const ping = await queryOne(pool, z.object({ ok: z.number() }), sql`select 1 as ok`);
        if (ping.ok) {
            await pool.close();
            return true;
        }
        await Bun.sleep(50);
    }
    await pool.close();
    return false;
}

export type DevCluster = {
    readonly databaseUrl: string;
    // Stops postgres if this process started it; a cluster another process owns is left running.
    readonly release: () => void;
};

// The persistent dev cluster under .moon/cache/dev: reused when another dev process already runs
// it, otherwise started as this process's direct child with no pipes, so it dies with us.
export async function openDevCluster(): Promise<DevCluster> {
    if (await answers(ADMIN_URL, 1)) {
        return { databaseUrl: DEV_DATABASE_URL, release: () => {} };
    }

    if (!existsSync(join(DEV_DATA_DIR, "PG_VERSION"))) {
        mkdirSync(DEV_DATA_DIR, { recursive: true });
        const init = Bun.spawnSync(
            [
                resolvePgBinary("initdb"),
                "--username=postgres",
                "--auth=trust",
                "--encoding=UTF8",
                "--locale=C",
                "-D",
                DEV_DATA_DIR,
            ],
            { stdout: "ignore", stderr: "pipe", timeout: 60_000 },
        );
        invariant(init.exitCode === 0, `initdb failed: ${init.stderr.toString()}`);
    }

    const server = Bun.spawn(
        [
            resolvePgBinary("postgres"),
            "-D",
            DEV_DATA_DIR,
            "-h",
            "127.0.0.1",
            "-p",
            String(DEV_PORT),
            "-c",
            "log_min_messages=warning",
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    invariant(await answers(ADMIN_URL, 200), `dev postgres did not answer on port ${DEV_PORT}`);

    const admin = openPool({ databaseUrl: ADMIN_URL, maxConnections: 1 });
    const present = await queryOne(
        admin,
        z.object({ present: z.boolean() }),
        sql`select exists (select 1 from pg_database where datname = ${DEV_DATABASE}) as present`,
    );
    invariant(present.ok, `reading pg_database failed: ${JSON.stringify(present)}`);
    if (present.value?.present !== true) {
        const created = await execute(admin, sql`create database lucent`);
        invariant(created.ok, `creating the dev database failed: ${JSON.stringify(created)}`);
    }
    await admin.close();

    let released = false;
    return {
        databaseUrl: DEV_DATABASE_URL,
        release: () => {
            if (released) return;
            released = true;
            // A fast shutdown checkpoints, so the next start skips crash recovery.
            ignoreErrorsSync(() => {
                Bun.spawnSync(
                    [resolvePgBinary("pg_ctl"), "stop", "-D", DEV_DATA_DIR, "-m", "fast", "-w"],
                    { stdout: "ignore", stderr: "ignore", timeout: 30_000 },
                );
            });
            server.kill();
        },
    };
}
