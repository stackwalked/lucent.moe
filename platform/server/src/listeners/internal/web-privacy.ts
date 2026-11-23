import type { Handlers } from "@lucent/rpc/mount";
import type { privacyContract } from "@lucent/rpc/web/privacy";
import { listOwnRestrictions } from "../../community/standing.ts";
import { served, type WebRpcContext } from "./web-shared.ts";

export const privacyHandlers = {
    "privacy.restrictions.list": async (ctx, _input, { session }) =>
        served(await listOwnRestrictions(ctx.auth.db, session)),
} satisfies Handlers<WebRpcContext, typeof privacyContract>;
