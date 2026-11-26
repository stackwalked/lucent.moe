import type { Handlers } from "@lucent/rpc/mount";
import type { privacyContract } from "@lucent/rpc/web/privacy";
import { listBlocks, setBlock } from "../../../members/community/blocks.ts";
import { exportOwnData } from "../../../members/community/export.ts";
import { setVisibility } from "../../../members/community/profiles.ts";
import { listOwnRestrictions } from "../../../members/community/standing.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const privacyHandlers = {
    "privacy.restrictions.list": async (ctx, _input, { session }) =>
        served(await listOwnRestrictions(ctx.auth.db, session)),
    "privacy.blocks.list": async (ctx, _input, { session }) =>
        served(await listBlocks(ctx.auth.db, session)),
    "privacy.blocks.set": async (ctx, input, { session }) =>
        served(done(await setBlock(ctx.auth.db, session, input))),
    "privacy.visibility.set": async (ctx, input, { session }) =>
        served(done(await setVisibility(ctx.auth.db, session, input))),
    "privacy.export.read": async (ctx, _input, { session }) =>
        served(await exportOwnData(ctx.auth.db, session)),
} satisfies Handlers<WebRpcContext, typeof privacyContract>;
