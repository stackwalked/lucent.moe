import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { DISCORD_RPC_PATH } from "@lucent/rpc/discord/contract";
import { mountInternalRpc } from "@lucent/rpc/mount";
import type { Hono } from "hono";
import type { Logger } from "../../../base/core/log.ts";
import type { EpochGuard } from "../../../base/db/epoch-guard.ts";
import type { CloudLimits } from "../../../delivery/cloud/items.rules.ts";
import type { OverrideSigner } from "../../../delivery/runtime/lease-key.ts";
import type { AuthDeps } from "../../../identity/auth/deps.ts";
import { createEventHub, type EventHub } from "../../../members/community/events.ts";
import { mountAvatars } from "./avatars.ts";
import { mountLoaderDownload } from "./download.ts";
import { mountCommunityEvents } from "./events.ts";
import { mountResourceFiles } from "./resources.ts";
import { webProcedures } from "./web-rpc.ts";

// Under any proxy idle timeout, and often enough that a signed-out tab's stream ends promptly.
const EVENTS_HEARTBEAT_MS = 25_000;

export function createInternalWebApp(deps: {
    // Presence for open streams; the server creates it so its stop path can end them.
    readonly events?: EventHub;
    readonly cloudLimits?: CloudLimits;
    readonly catalog: ProductCatalog;
    readonly auth: AuthDeps;
    readonly epochGuard: EpochGuard;
    readonly webInternalKey: string;
    // Where `ops publish-loader` wrote the loader's bytes, and resources are kept; null without
    // the loaders' listener.
    readonly artifactDir: string | null;
    // Null without the loaders' listener.
    readonly overrideSigner?: OverrideSigner | null;
    readonly logger: Logger;
}): Hono {
    const events = deps.events ?? createEventHub();
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
                    artifactDir: deps.artifactDir,
                    overrideSigner: deps.overrideSigner ?? null,
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
    mountResourceFiles(app, {
        auth: deps.auth,
        catalog: deps.catalog,
        artifactDir: deps.artifactDir,
        isSuperseded: deps.epochGuard.isSuperseded,
        logger: deps.logger,
    });
    mountAvatars(app, {
        db: deps.auth.db,
        isSuperseded: deps.epochGuard.isSuperseded,
        logger: deps.logger,
    });
    return app;
}

type Fetch = (req: Request) => Response | Promise<Response>;

// One listener, one mount per peer. Each mount checks its own key on every path it is given, so a
// request reaches the discord mount only on the discord path and web's otherwise.
export function routeInternal(params: {
    readonly web: Fetch;
    readonly discord: Fetch | null;
}): Fetch {
    return (req) => {
        if (params.discord !== null && new URL(req.url).pathname === DISCORD_RPC_PATH) {
            return params.discord(req);
        }
        return params.web(req);
    };
}
