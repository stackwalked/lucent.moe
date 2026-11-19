import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ignoreErrors, ignoreErrorsSync, invariant, onThrowCleanup } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { toHex } from "@lucent/core/scalars";
import { z } from "zod";
import { resolvePgBinary, WORKSPACE_ROOT } from "../../dev/postgres.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { type Db, execute, openPool, queryOne, sql, sqlIdent } from "../../src/db/pool.ts";

const PG_TEST_CACHE_DIR = join(WORKSPACE_ROOT, ".moon/cache/pg-test");

function allocateEphemeralPort(): number {
    const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
            data() {},
        },
    });
    const port = listener.port;
    listener.stop(true);
    return port;
}

export type TestCluster = {
    readonly port: number;
    readonly urlFor: (dbName: string) => string;
    readonly withTestDb: <T>(
        work: (ctx: {
            readonly databaseUrl: string;
            readonly nativeDb: Db;
            readonly browserDb: Db;
        }) => Promise<T>,
        options?: { readonly template?: "migrated" | "empty"; readonly browserTimeoutMs?: number },
    ) => Promise<T>;
    readonly shutdown: () => Promise<void>;
};

let sharedClusterPromise: Promise<TestCluster> | null = null;
let dbCounter = 0;

function isPidAlive(pid: number): boolean {
    let alive = false;
    ignoreErrorsSync(() => {
        process.kill(pid, 0);
        alive = true;
    });
    return alive;
}

function sweepOrphanedRuns(pgCtlBin: string): void {
    if (!existsSync(PG_TEST_CACHE_DIR)) return;
    for (const entry of readdirSync(PG_TEST_CACHE_DIR)) {
        const match = /^run_(\d+)_/.exec(entry);
        if (match === null) continue;
        const ownerPid = Number(match[1]);
        if (ownerPid === process.pid || isPidAlive(ownerPid)) continue;
        const entryDir = join(PG_TEST_CACHE_DIR, entry);
        const entryDataDir = join(entryDir, "data");
        if (existsSync(join(entryDataDir, "postmaster.pid"))) {
            ignoreErrorsSync(() => {
                Bun.spawnSync([pgCtlBin, "stop", "-D", entryDataDir, "-m", "immediate", "-w"], {
                    stdout: "ignore",
                    stderr: "ignore",
                });
            });
        }
        ignoreErrorsSync(() => {
            rmSync(entryDir, { recursive: true, force: true });
        });
    }
}

async function startTestCluster(): Promise<TestCluster> {
    const initdbBin = resolvePgBinary("initdb");
    const postgresBin = resolvePgBinary("postgres");
    const pgCtlBin = resolvePgBinary("pg_ctl");
    sweepOrphanedRuns(pgCtlBin);

    const rng = createSeededRng(process.pid ^ 0x5f3759df);
    const runTag = toHex(rng.fillBytes(new Uint8Array(6)));
    const runDir = join(PG_TEST_CACHE_DIR, `run_${process.pid}_${runTag}`);
    const dataDir = join(runDir, "data");
    mkdirSync(runDir, { recursive: true });

    const initProc = Bun.spawn(
        [
            initdbBin,
            "--no-sync",
            "--username=postgres",
            "--auth=trust",
            "--encoding=UTF8",
            "--locale=C",
            "-D",
            dataDir,
        ],
        {
            stdout: "pipe",
            stderr: "pipe",
            timeout: 30_000,
        },
    );
    const initExit = await initProc.exited;
    if (initExit !== 0) {
        const stderrText = await new Response(initProc.stderr).text();
        invariant(false, `initdb failed (${initExit}): ${stderrText}`);
    }

    const port = allocateEphemeralPort();
    const serverProc = Bun.spawn(
        [
            postgresBin,
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
        {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        },
    );

    const urlFor = (dbName: string): string => `postgres://postgres@127.0.0.1:${port}/${dbName}`;

    const adminPool = openPool({
        databaseUrl: urlFor("postgres"),
        maxConnections: 4,
        applicationName: "lucent-pg-test-admin",
        allowExitOnIdle: true,
    });

    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
        const ping = await queryOne(adminPool, z.object({ ok: z.number() }), sql`select 1 as ok`);
        if (ping.ok && ping.value?.ok === 1) {
            ready = true;
            break;
        }
        await Bun.sleep(40);
    }
    invariant(ready, "ephemeral PostgreSQL 18 server failed to become ready");

    const createTpl = await execute(adminPool, sql`create database lucent_template`);
    invariant(createTpl.ok, "failed creating lucent_template database");

    const templatePool = openPool({
        databaseUrl: urlFor("lucent_template"),
        maxConnections: 2,
    });
    const migrated = await migrateDatabase(templatePool);
    await templatePool.close();
    invariant(migrated.ok, `failed migrating lucent_template: ${JSON.stringify(migrated)}`);

    let stopped = false;
    const stopClusterSync = (): void => {
        if (stopped) return;
        stopped = true;
        ignoreErrorsSync(() => {
            Bun.spawnSync([pgCtlBin, "stop", "-D", dataDir, "-m", "immediate", "-w"], {
                stdout: "ignore",
                stderr: "ignore",
            });
        });
        serverProc.kill();
        ignoreErrorsSync(() => {
            rmSync(runDir, { recursive: true, force: true });
        });
    };

    const shutdown = async (): Promise<void> => {
        await adminPool.close();
        stopClusterSync();
        await ignoreErrors(() => serverProc.exited);
    };

    return {
        port,
        urlFor,
        async withTestDb(work, options) {
            dbCounter += 1;
            const dbName = `t_${process.pid}_${dbCounter}`;
            const ident = sqlIdent(dbName);
            const sourceTemplate = options?.template === "empty" ? "template0" : "lucent_template";
            const createStmt =
                sourceTemplate === "lucent_template"
                    ? sql`create database ${ident} template lucent_template`
                    : sql`create database ${ident} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`;

            const created = await execute(adminPool, createStmt);
            invariant(
                created.ok,
                `failed creating test database ${dbName}: ${JSON.stringify(created)}`,
            );

            const databaseUrl = urlFor(dbName);
            const nativeDb = openPool({
                databaseUrl,
                maxConnections: 6,
                applicationName: "test-native",
            });
            const browserDb = openPool({
                databaseUrl,
                maxConnections: 4,
                statementTimeoutMs: options?.browserTimeoutMs ?? 5_000,
                applicationName: "test-browser",
            });

            const cleanup = async (): Promise<void> => {
                await browserDb.close();
                await nativeDb.close();
                const dropStmt = sql`drop database if exists ${ident} with (force)`;
                await execute(adminPool, dropStmt);
            };

            const outcome = await onThrowCleanup(
                () => work({ databaseUrl, nativeDb, browserDb }),
                cleanup,
            );
            await cleanup();
            return outcome;
        },
        shutdown,
    };
}

export function sharedTestCluster(): Promise<TestCluster> {
    if (sharedClusterPromise === null) {
        sharedClusterPromise = startTestCluster();
    }
    return sharedClusterPromise;
}

// Called once, after the last test file (tests/harness/teardown.ts). If the run dies first, bun
// kills postgres (its direct child) on the way out and the next run's sweep removes the directory.
export async function shutdownSharedTestCluster(): Promise<void> {
    if (sharedClusterPromise === null) {
        return;
    }
    const cluster = await sharedClusterPromise;
    sharedClusterPromise = null;
    await cluster.shutdown();
}
