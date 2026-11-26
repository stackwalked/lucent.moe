import type { Handlers } from "@lucent/rpc/mount";
import type { searchContract } from "@lucent/rpc/web/search";
import { searchCommunity } from "../../../members/community/search.ts";
import { served, type WebRpcContext } from "./web-shared.ts";

export const searchHandlers = {
    "search.results.list": async (ctx, input, { session }) =>
        served(await searchCommunity(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
} satisfies Handlers<WebRpcContext, typeof searchContract>;
