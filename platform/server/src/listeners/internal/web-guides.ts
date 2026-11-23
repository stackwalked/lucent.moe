import type { Handlers } from "@lucent/rpc/mount";
import type { guidesContract } from "@lucent/rpc/web/guides";
import { createGuide, listGuides, readGuide, updateGuide } from "../../community/guides.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const guidesHandlers = {
    "guides.list": async (ctx, input, { session }) =>
        served(await listGuides(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
    "guides.get": async (ctx, input, { session }) =>
        served(await readGuide(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
    "guides.create": async (ctx, input, { session }) =>
        served(await createGuide(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
    "guides.update": async (ctx, input, { session }) =>
        served(done(await updateGuide(ctx.auth.db, session, { ...input, catalog: ctx.catalog }))),
} satisfies Handlers<WebRpcContext, typeof guidesContract>;
