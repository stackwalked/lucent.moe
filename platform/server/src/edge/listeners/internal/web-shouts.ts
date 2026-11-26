import type { Handlers } from "@lucent/rpc/mount";
import type { shoutsContract } from "@lucent/rpc/web/shouts";
import {
    createShout,
    deleteShout,
    listShouts,
    purgeShouts,
} from "../../../members/community/shouts.ts";
import { asStaff, done, served, type WebRpcContext } from "./web-shared.ts";

export const shoutsHandlers = {
    "shouts.list": async (ctx, input, { session }) =>
        served(await listShouts(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
    "shouts.create": async (ctx, input, { session }) =>
        served(await createShout(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
    // Run as the session's account: its own shout needs nothing more, someone else's needs
    // `moderation:remove` (deleteShout decides under lock).
    "shouts.delete": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(await deleteShout({ db: ctx.auth.db, caller, id: input.id })),
        ),
    "admin.shouts.purge": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => purgeShouts({ db: ctx.auth.db, caller, target: input })),
} satisfies Handlers<WebRpcContext, typeof shoutsContract>;
