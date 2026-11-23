import type { Handlers } from "@lucent/rpc/mount";
import type { inboxContract } from "@lucent/rpc/web/inbox";
import { countUnread, listInbox, markRead } from "../../notify/inbox.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const inboxHandlers = {
    "inbox.entries.list": async (ctx, input, { session }) =>
        served(
            await listInbox(ctx.auth.db, session, { cursor: input.cursor, catalog: ctx.catalog }),
        ),
    "inbox.entries.read": async (ctx, input, { session }) =>
        served(
            done(await markRead(ctx.auth.db, session, { entryId: input.id, catalog: ctx.catalog })),
        ),
    "inbox.unread.count": async (ctx, _input, { session }) =>
        served(await countUnread(ctx.auth.db, session, ctx.catalog)),
} satisfies Handlers<WebRpcContext, typeof inboxContract>;
