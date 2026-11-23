import type { Handlers } from "@lucent/rpc/mount";
import type { commentsContract } from "@lucent/rpc/web/comments";
import { createComment, listComments } from "../../community/comments.ts";
import { served, type WebRpcContext } from "./web-shared.ts";

export const commentsHandlers = {
    "comments.list": async (ctx, input, { session }) =>
        served(await listComments(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
    "comments.create": async (ctx, input, { session }) =>
        served(await createComment(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
} satisfies Handlers<WebRpcContext, typeof commentsContract>;
