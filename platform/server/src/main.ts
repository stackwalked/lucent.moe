import { systemClock } from "@lucent/core/clock";
import { createJsonlLogger, writeToStdout } from "./base/core/log.ts";
import { startServer } from "./boot.ts";
import { processEnvironment, readServerConfig } from "./config.ts";

// Exit codes a supervisor can act on: 1 is bad configuration or an unreachable dependency (fix
// and restart), 2 is a schema this build doesn't match (run `ops migrate`, or roll back).
const EXIT_FAILED = 1;
const EXIT_SCHEMA_NOT_CURRENT = 2;

const logger = createJsonlLogger({ clock: systemClock, sink: writeToStdout });

const config = readServerConfig(processEnvironment());
if (!config.ok) {
    for (const problem of config.error.problems) {
        logger.write("error", "config invalid", { origin: "boot", detail: problem });
    }
    process.exit(EXIT_FAILED);
}

const started = await startServer({ config: config.value, logger });
if (!started.ok) {
    logger.write("error", started.error.code, { origin: "boot", detail: started.error.detail });
    process.exit(
        started.error.code === "SCHEMA_NOT_CURRENT" ? EXIT_SCHEMA_NOT_CURRENT : EXIT_FAILED,
    );
}

const server = started.value;
let stopping = false;
const drain = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.write("info", "draining", { origin: "boot" });
    await server.stop();
    process.exit(0);
};
process.on("SIGTERM", () => void drain());
process.on("SIGINT", () => void drain());
