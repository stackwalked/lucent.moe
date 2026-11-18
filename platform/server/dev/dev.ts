import { join } from "node:path";
import { startServer } from "../src/boot.ts";
import { systemClock } from "../src/core/clock.ts";
import { invariant } from "../src/core/contain.ts";
import { createJsonlLogger, writeToStdout } from "../src/core/log.ts";
import { migrateDatabase } from "../src/db/migrate.ts";
import { openPool } from "../src/db/pool.ts";
import { openDevCluster, WORKSPACE_ROOT } from "./postgres.ts";

// The server against the dev cluster, migrated on start. Config is built here rather than read
// from the environment: dev values are fixed so web's dev server can name the same ones.

// Public on purpose: it only ever guards a loopback listener on a developer's machine.
const DEV_INTERNAL_KEY = "lucent-dev-internal-key-public-not-a-secret-0000";

const cluster = await openDevCluster();

const migrator = openPool({ databaseUrl: cluster.databaseUrl, maxConnections: 1 });
const migrated = await migrateDatabase(migrator);
await migrator.close();
invariant(migrated.ok, `migrating the dev database failed: ${JSON.stringify(migrated)}`);

const logger = createJsonlLogger({ clock: systemClock, sink: writeToStdout });
const started = await startServer({
    config: {
        databaseUrl: cluster.databaseUrl,
        internalListen: { kind: "loopback", hostname: "127.0.0.1", port: 4712 },
        webInternalKey: DEV_INTERNAL_KEY,
        productsDir: join(WORKSPACE_ROOT, "products"),
    },
    logger,
});
if (!started.ok) {
    logger.write("error", started.error.code, { origin: "boot", detail: started.error.detail });
    cluster.release();
    process.exit(1);
}

const stop = async (): Promise<void> => {
    await started.value.stop();
    cluster.release();
    process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
