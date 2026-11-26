import { systemClock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import { createJsonlLogger, writeToStdout } from "../src/base/core/log.ts";
import { migrateDatabase } from "../src/base/db/migrate.ts";
import { openPool } from "../src/base/db/pool.ts";
import { startServer } from "../src/boot.ts";
import { processEnvironment, readServerConfig } from "../src/config.ts";
import { openDevCluster } from "./postgres.ts";

// The server against the dev cluster, migrated on start. Config comes from the environment as in
// production; moon loads it from .config/dev.env, which web's dev server reads too.

const logger = createJsonlLogger({ clock: systemClock, sink: writeToStdout });
const config = readServerConfig(processEnvironment());
if (!config.ok) {
    for (const problem of config.error.problems) {
        logger.write("error", "config invalid", { origin: "boot", detail: problem });
    }
    process.exit(1);
}

const cluster = await openDevCluster();
invariant(
    config.value.databaseUrl === cluster.databaseUrl,
    "LUCENT_DATABASE_URL must name the dev cluster (.config/dev.env)",
);

const migrator = openPool({ databaseUrl: cluster.databaseUrl, maxConnections: 1 });
const migrated = await migrateDatabase(migrator);
await migrator.close();
invariant(migrated.ok, `migrating the dev database failed: ${JSON.stringify(migrated)}`);

const started = await startServer({ config: config.value, logger });
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
