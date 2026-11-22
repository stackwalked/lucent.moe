import { ok } from "@lucent/core/result";
import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import type { WebRpcContext } from "./web-shared.ts";

export const healthHandlers = {
    "health.check": (ctx) => Promise.resolve(ok({ productsLoaded: ctx.catalog.size })),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
