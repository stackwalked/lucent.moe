import type { Hono } from "hono";
import { z } from "zod";
import type { Logger } from "../core/log.ts";
import { err, ok } from "../core/result.ts";
import { mountInternalRpc, procedure } from "../core/rpc.ts";
import type { EpochGuard } from "../db/epoch-guard.ts";
import { type ProductCatalog, ProductDefinition } from "../products/catalog.ts";

export type WebRpcContext = {
    readonly catalog: ProductCatalog;
};

export const webRpc = {
    "health.check": procedure({
        input: z.strictObject({}),
        output: z.strictObject({ productsLoaded: z.number().int().nonnegative() }),
        error: z.never(),
        run: (ctx: WebRpcContext) => Promise.resolve(ok({ productsLoaded: ctx.catalog.size })),
    }),
    "catalog.list": procedure({
        input: z.strictObject({}),
        output: z.array(ProductDefinition).readonly(),
        error: z.never(),
        run: (ctx: WebRpcContext) => Promise.resolve(ok([...ctx.catalog.values()])),
    }),
};

export type WebRpc = typeof webRpc;

export function createInternalWebApp(deps: {
    readonly catalog: ProductCatalog;
    readonly epochGuard: EpochGuard;
    readonly webInternalKey: string;
    readonly logger: Logger;
}): Hono {
    return mountInternalRpc({
        path: "/internal/web/rpc",
        peerKey: deps.webInternalKey,
        procedures: webRpc,
        createContext: () => {
            if (deps.epochGuard.isSuperseded()) {
                return Promise.resolve(err({ code: "SERVICE_UNAVAILABLE" as const }));
            }
            return Promise.resolve(ok({ catalog: deps.catalog }));
        },
        onUnhandledError: (detail, failureKind) => {
            deps.logger.write("error", failureKind, { origin: "internal-web", detail });
        },
    });
}
