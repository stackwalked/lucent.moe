import { existsSync, rmSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { systemClock } from "@lucent/core/clock";
import { systemCryptoRng } from "@lucent/core/rng";

import { processEnvironment, readWebConfig } from "./server/config.ts";
import { connectPlatform } from "./server/connect.ts";
import { type AssetServer, createWebEntry, type StartHandler } from "./server/entry.ts";
import { createThrottle } from "./server/throttle.ts";

// Serves the production build: /assets from dist/client, everything else through the entry to
// Start's handler from dist/server. Exit 1 is bad configuration or a missing build.

const DIST = join(import.meta.dir, "../dist");
const DRAIN_MS = 10_000;

function writeLine(line: string): void {
    process.stdout.write(line);
}

const config = readWebConfig(processEnvironment());
if (!config.ok) {
    for (const problem of config.error.problems) {
        writeLine(
            `${JSON.stringify({ level: "error", msg: "config invalid", detail: problem })}\n`,
        );
    }
    process.exit(1);
}

function isStartBuild(mod: unknown): mod is { readonly default: { readonly fetch: StartHandler } } {
    if (typeof mod !== "object" || mod === null || !("default" in mod)) return false;
    const entry = mod.default;
    return (
        typeof entry === "object" &&
        entry !== null &&
        "fetch" in entry &&
        typeof entry.fetch === "function"
    );
}

const serverBuild = join(DIST, "server/server.js");
if (!existsSync(serverBuild)) {
    writeLine(`${JSON.stringify({ level: "error", msg: "no build", detail: "run web:build" })}\n`);
    process.exit(1);
}
const built: unknown = await import(serverBuild);
if (!isStartBuild(built)) {
    writeLine(
        `${JSON.stringify({ level: "error", msg: "not a Start build", detail: serverBuild })}\n`,
    );
    process.exit(1);
}

const clientDir = join(DIST, "client");

// Hashed file names never change content, so they cache for good.
const assets: AssetServer = async (pathname) => {
    const path = normalize(join(clientDir, pathname));
    if (!path.startsWith(clientDir + sep)) return null;
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return new Response(file, {
        headers: { "cache-control": "public, max-age=31536000, immutable" },
    });
};

const platform = connectPlatform(config.value.platform, config.value.peerKey);

const entry = createWebEntry({
    publicOrigin: config.value.publicOrigin,
    clock: systemClock,
    rng: systemCryptoRng,
    start: built.default.fetch,
    assets,
    checkPlatform: async () => (await platform.call("health.check", {})).ok,
    throttle: createThrottle({ clock: systemClock }),
    sink: writeLine,
});

const listen = config.value.listen;
if (listen.kind === "unix") rmSync(listen.path, { force: true });
const server = Bun.serve({
    ...(listen.kind === "unix"
        ? { unix: listen.path }
        : { hostname: listen.hostname, port: listen.port }),
    fetch: (req, srv) => entry(req, srv.requestIP(req)?.address ?? null),
});
// The bind address answers only requests for the public origin's host (421 otherwise), so the
// line names the URL to open, not the socket.
writeLine(
    `${JSON.stringify({ level: "info", msg: "listening", detail: `${String(server.url)} serving ${config.value.publicOrigin}` })}\n`,
);

// Stop taking connections, give requests in flight up to ten seconds, then exit.
let stopping = false;
const drain = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await Promise.race([server.stop(), Bun.sleep(DRAIN_MS)]);
    process.exit(0);
};
process.on("SIGTERM", () => void drain());
process.on("SIGINT", () => void drain());
