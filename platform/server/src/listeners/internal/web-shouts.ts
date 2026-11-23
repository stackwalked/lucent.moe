import type { Handlers } from "@lucent/rpc/mount";
import type { shoutsContract } from "@lucent/rpc/web/shouts";
import { createShout, listShouts } from "../../community/shouts.ts";
import { served, type WebRpcContext } from "./web-shared.ts";

export const shoutsHandlers = {
    "shouts.list": async (ctx, input, { session }) =>
        served(await listShouts(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
    "shouts.create": async (ctx, input, { session }) =>
        served(await createShout(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
} satisfies Handlers<WebRpcContext, typeof shoutsContract>;
