import { ok } from "@lucent/core/result";
import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import type { WebRpcContext } from "./web-shared.ts";

export const catalogHandlers = {
    "catalog.list": (ctx) => Promise.resolve(ok([...ctx.catalog.values()])),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
