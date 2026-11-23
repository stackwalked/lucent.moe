import { ok } from "@lucent/core/result";
import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { listIssuableProducts, listPublicProducts } from "../../products/products.ts";
import { asStaff, type WebRpcContext } from "./web-shared.ts";

export const catalogHandlers = {
    "catalog.list": (ctx) => Promise.resolve(ok(listPublicProducts(ctx.catalog))),
    "catalog.products.list": (ctx) => Promise.resolve(ok(listPublicProducts(ctx.catalog))),
    "admin.entitlements.listProducts": (ctx, _input, call) =>
        asStaff(ctx, call, (caller) =>
            listIssuableProducts(ctx.auth.db, { catalog: ctx.catalog, caller }),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
