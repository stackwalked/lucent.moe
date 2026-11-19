import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { mountInternalRpc } from "@lucent/rpc/mount";
import type { Hono } from "hono";
import type { AuthDeps } from "../auth/deps.ts";
import type { Logger } from "../core/log.ts";
import type { EpochGuard } from "../db/epoch-guard.ts";
import { webProcedures } from "./web-rpc.ts";

export function createInternalWebApp(deps: {
    readonly catalog: ProductCatalog;
    readonly auth: AuthDeps;
    readonly epochGuard: EpochGuard;
    readonly webInternalKey: string;
    readonly logger: Logger;
}): Hono {
    return mountInternalRpc({
        path: "/internal/web/rpc",
        peerKey: deps.webInternalKey,
        procedures: webProcedures,
        createContext: () => {
            if (deps.epochGuard.isSuperseded()) {
                return Promise.resolve(err({ code: "SERVICE_UNAVAILABLE" as const }));
            }
            return Promise.resolve(ok({ catalog: deps.catalog, auth: deps.auth }));
        },
        onUnhandledError: ({ detail, kind, requestId }) => {
            deps.logger.write("error", kind, { origin: "internal-web", detail, requestId });
        },
    });
}
