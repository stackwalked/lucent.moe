import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "@lucent/core/clock";
import { createRpcClient } from "@lucent/rpc/client";
import { DISCORD_RPC_PATH, discordContract } from "@lucent/rpc/discord/contract";
import { type PlatformAddress, processEnvironment, readConnectorConfig } from "./config.ts";
import { createConnector } from "./connector.ts";
import { createJsonlLogger } from "./log.ts";

// The process has no listener, so its health check reads this file's age: it is touched after
// every tick that reached platform.
const ALIVE_FILE = join(tmpdir(), "lucent-discord-alive");

function connectPlatform(address: PlatformAddress, peerKey: string) {
    if (address.kind === "http") {
        return createRpcClient(discordContract, {
            endpointUrl: `${address.origin}${DISCORD_RPC_PATH}`,
            peerKey,
        });
    }
    return createRpcClient(discordContract, {
        endpointUrl: `http://platform${DISCORD_RPC_PATH}`,
        peerKey,
        fetcher: (req) => fetch(req, { unix: address.path }),
    });
}

const logger = createJsonlLogger({
    clock: systemClock,
    sink: (line) => process.stdout.write(line),
});
const config = readConnectorConfig(processEnvironment());
if (!config.ok) {
    logger.write("error", "config invalid", {
        origin: "boot",
        detail: config.error.problems.join("; "),
    });
    process.exit(1);
}
const connector = createConnector({
    platform: connectPlatform(config.value.platform, config.value.peerKey),
    botToken: config.value.botToken,
    guildId: config.value.guildId,
    logger,
    schedule: "timers",
    onAlive: () => {
        void Bun.write(ALIVE_FILE, "");
    },
});
const started = await connector.start();
if (!started.ok) {
    logger.write("error", "gateway unavailable", { origin: "boot", detail: started.error.detail });
    process.exit(1);
}
logger.write("info", "started", { origin: "boot" });

process.on("SIGTERM", () => {
    void connector.stop().then(() => process.exit(0));
});
