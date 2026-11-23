import type { Handlers } from "@lucent/rpc/mount";
import type { moderationContract } from "@lucent/rpc/web/moderation";
import {
    liftRestriction,
    listRestrictions,
    setRestriction,
} from "../../moderation/restrictions.ts";
import { asStaff, mapOk, type WebRpcContext } from "./web-shared.ts";

export const moderationHandlers = {
    "admin.moderation.restrictions.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            listRestrictions(ctx.auth.db, { caller, cursor: input.cursor }),
        ),
    "admin.moderation.restrictions.set": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            setRestriction({ db: ctx.auth.db, catalog: ctx.catalog, caller, ...input }),
        ),
    "admin.moderation.restrictions.lift": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(await liftRestriction({ db: ctx.auth.db, caller, id: input.id }), () => ({})),
        ),
} satisfies Handlers<WebRpcContext, typeof moderationContract>;
