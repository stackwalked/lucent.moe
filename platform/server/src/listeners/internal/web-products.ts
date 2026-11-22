import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { listMemberProducts } from "../../products/products.ts";
import { mapOk, served, type WebRpcContext } from "./web-shared.ts";

export const productsHandlers = {
    "products.list": async (ctx, _input, { session }) =>
        served(
            mapOk(
                await listMemberProducts(ctx.auth.db, {
                    catalog: ctx.catalog,
                    sessionToken: session,
                }),
                (products) => ({ products }),
            ),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
