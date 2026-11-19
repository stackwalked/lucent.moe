import { invariant, onThrowCleanup } from "@lucent/core/contain";
import { type EphemeralCluster, sharedEphemeralCluster } from "@lucent/testing/postgres";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { type Db, openPool } from "../../src/db/pool.ts";

// The shared ephemeral cluster with platform's schema in a template, so each test copies a
// migrated database instead of migrating its own.
export type TestCluster = {
    readonly withTestDb: <T>(
        work: (ctx: {
            readonly databaseUrl: string;
            readonly nativeDb: Db;
            readonly browserDb: Db;
        }) => Promise<T>,
        options?: { readonly template?: "migrated" | "empty"; readonly browserTimeoutMs?: number },
    ) => Promise<T>;
};

const TEMPLATE = "lucent_template";

let prepared: Promise<TestCluster> | null = null;
let dbCounter = 0;

async function prepare(cluster: EphemeralCluster): Promise<TestCluster> {
    const templatePool = openPool({
        databaseUrl: await cluster.createDatabase(TEMPLATE, "template0"),
        maxConnections: 2,
    });
    const migrated = await migrateDatabase(templatePool);
    await templatePool.close();
    invariant(migrated.ok, `failed migrating ${TEMPLATE}: ${JSON.stringify(migrated)}`);

    return {
        async withTestDb(work, options) {
            dbCounter += 1;
            const dbName = `t_${process.pid}_${dbCounter}`;
            const databaseUrl = await cluster.createDatabase(
                dbName,
                options?.template === "empty" ? "template0" : TEMPLATE,
            );
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
                await cluster.dropDatabase(dbName);
            };
            const outcome = await onThrowCleanup(
                () => work({ databaseUrl, nativeDb, browserDb }),
                cleanup,
            );
            await cleanup();
            return outcome;
        },
    };
}

export function sharedTestCluster(): Promise<TestCluster> {
    prepared ??= sharedEphemeralCluster().then(prepare);
    return prepared;
}
