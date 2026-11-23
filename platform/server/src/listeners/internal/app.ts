import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { mountInternalRpc } from "@lucent/rpc/mount";
import type { Hono } from "hono";
import type { AuthDeps } from "../../auth/deps.ts";
import type { CloudLimits } from "../../cloud/items.rules.ts";
import { createEventHub } from "../../community/events.ts";
import type { Logger } from "../../core/log.ts";
import type { EpochGuard } from "../../db/epoch-guard.ts";
import { mountLoaderDownload } from "./download.ts";
import { mountCommunityEvents } from "./events.ts";
import { webProcedures } from "./web-rpc.ts";

// Under any proxy idle timeout, and often enough that a signed-out tab's stream ends promptly.
const EVENTS_HEARTBEAT_MS = 25_000;

export function createInternalWebApp(deps: {
    readonly cloudLimits?: CloudLimits;
    readonly catalog: ProductCatalog;
    readonly auth: AuthDeps;
    readonly epochGuard: EpochGuard;
    readonly webInternalKey: string;
    // Where `ops publish-loader` wrote the loader's bytes; null without the loaders' listener.
    readonly artifactDir: string | null;
    readonly logger: Logger;
}): Hono {
    const events = createEventHub();
    const app = mountInternalRpc({
        path: "/internal/web/rpc",
        peerKey: deps.webInternalKey,
        procedures: webProcedures,
        createContext: () => {
            if (deps.epochGuard.isSuperseded()) {
                return Promise.resolve(err({ code: "SERVICE_UNAVAILABLE" as const }));
            }
            return Promise.resolve(
                ok({
                    catalog: deps.catalog,
                    auth: deps.auth,
                    logger: deps.logger,
                    events,
                    ...(deps.cloudLimits === undefined ? {} : { cloudLimits: deps.cloudLimits }),
                }),
            );
        },
        onUnhandledError: ({ detail, kind, requestId }) => {
            deps.logger.write("error", kind, { origin: "internal-web", detail, requestId });
        },
    });
    // Registered after the mount's middleware, so behind the same peer-key check and containment.
    mountCommunityEvents(app, {
        db: deps.auth.db,
        hub: events,
        isSuperseded: deps.epochGuard.isSuperseded,
        heartbeatMs: EVENTS_HEARTBEAT_MS,
    });
    mountLoaderDownload(app, {
        db: deps.auth.db,
        catalog: deps.catalog,
        artifactDir: deps.artifactDir,
        isSuperseded: deps.epochGuard.isSuperseded,
        logger: deps.logger,
    });
    return app;
}
