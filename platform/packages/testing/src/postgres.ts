import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ignoreErrors, ignoreErrorsSync, invariant, tryAsync } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { toHex } from "@lucent/core/scalars";
import { SQL } from "bun";

export const WORKSPACE_ROOT = join(import.meta.dir, "../../../..");

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

export function allocateEphemeralPort(): number {
    const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
    });
    const port = listener.port;
    listener.stop(true);
    return port;
}

const CACHE_DIR = join(WORKSPACE_ROOT, ".moon/cache/pg-test");
const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

// A throwaway PostgreSQL for one test process: trust auth on loopback, durability off, gone when
// the process is. Databases are made by copying a template; what goes into a template is the
// caller's business (platform's migrations, or none).
export type EphemeralCluster = {
    readonly port: number;
    readonly urlFor: (database: string) => string;
    readonly createDatabase: (name: string, template: string) => Promise<string>;
    readonly dropDatabase: (name: string) => Promise<void>;
    readonly shutdown: () => Promise<void>;
};

function isPidAlive(pid: number): boolean {
    let alive = false;
    ignoreErrorsSync(() => {
        process.kill(pid, 0);
        alive = true;
    });
    return alive;
}

// A run that died before its teardown left its directory, and maybe its postgres, behind.
function sweepOrphanedRuns(pgCtl: string): void {
    if (!existsSync(CACHE_DIR)) return;
    for (const entry of readdirSync(CACHE_DIR)) {
        const match = /^run_(\d+)_/.exec(entry);
        if (match === null) continue;
        const ownerPid = Number(match[1]);
        if (ownerPid === process.pid || isPidAlive(ownerPid)) continue;
        const dir = join(CACHE_DIR, entry);
        const dataDir = join(dir, "data");
        if (existsSync(join(dataDir, "postmaster.pid"))) {
            ignoreErrorsSync(() => {
                Bun.spawnSync([pgCtl, "stop", "-D", dataDir, "-m", "immediate", "-w"], {
                    stdout: "ignore",
                    stderr: "ignore",
                });
            });
        }
        ignoreErrorsSync(() => rmSync(dir, { recursive: true, force: true }));
    }
}

async function startEphemeralCluster(): Promise<EphemeralCluster> {
    const pgCtl = resolvePgBinary("pg_ctl");
    sweepOrphanedRuns(pgCtl);

    const rng = createSeededRng(process.pid ^ 0x5f3759df);
    const runDir = join(CACHE_DIR, `run_${process.pid}_${toHex(rng.fillBytes(new Uint8Array(6)))}`);
    const dataDir = join(runDir, "data");
    mkdirSync(runDir, { recursive: true });

    const init = Bun.spawn(
        [
            resolvePgBinary("initdb"),
            "--no-sync",
            "--username=postgres",
            "--auth=trust",
            "--encoding=UTF8",
            "--locale=C",
            "-D",
            dataDir,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const initExit = await init.exited;
    if (initExit !== 0) {
        invariant(false, `initdb failed (${initExit}): ${await new Response(init.stderr).text()}`);
    }

    const port = allocateEphemeralPort();
    const server = Bun.spawn(
        [
            resolvePgBinary("postgres"),
            "-D",
            dataDir,
            "-F",
            "-h",
            "127.0.0.1",
            "-p",
            String(port),
            "-c",
            "synchronous_commit=off",
            "-c",
            "full_page_writes=off",
            "-c",
            "max_connections=60",
            "-c",
            "log_min_messages=fatal",
        ],
        // No pipes: a postgres that outlived this process would hold them, and whatever reads
        // this process's output would wait on them forever.
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );

    const urlFor = (database: string): string =>
        `postgres://postgres@127.0.0.1:${port}/${database}`;
    const admin = new SQL({ url: urlFor("postgres"), max: 2 });

    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt++) {
        ready = (
            await tryAsync(
                async () => await admin`select 1`,
                () => null,
            )
        ).ok;
        if (!ready) await Bun.sleep(40);
    }
    invariant(ready, "the ephemeral PostgreSQL never answered");

    let stopped = false;
    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        ignoreErrorsSync(() => {
            Bun.spawnSync([pgCtl, "stop", "-D", dataDir, "-m", "immediate", "-w"], {
                stdout: "ignore",
                stderr: "ignore",
            });
        });
        server.kill();
        ignoreErrorsSync(() => rmSync(runDir, { recursive: true, force: true }));
    };

    return {
        port,
        urlFor,
        async createDatabase(name, template) {
            invariant(DATABASE_NAME.test(name) && DATABASE_NAME.test(template), "plain names");
            await admin.unsafe(
                `create database ${name} template ${template} encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`,
            );
            return urlFor(name);
        },
        async dropDatabase(name) {
            invariant(DATABASE_NAME.test(name), "a plain name");
            await admin.unsafe(`drop database if exists ${name} with (force)`);
        },
        async shutdown() {
            await ignoreErrors(() => admin.close());
            stop();
            await ignoreErrors(() => server.exited);
        },
    };
}

let shared: Promise<EphemeralCluster> | null = null;

// One cluster per test process, started by the first test that asks.
export function sharedEphemeralCluster(): Promise<EphemeralCluster> {
    shared ??= startEphemeralCluster();
    return shared;
}

// After the last test file. If the run dies first, bun kills postgres (its direct child) on the
// way out and the next run's sweep removes the directory.
export async function shutdownSharedEphemeralCluster(): Promise<void> {
    if (shared === null) return;
    const cluster = await shared;
    shared = null;
    await cluster.shutdown();
}
