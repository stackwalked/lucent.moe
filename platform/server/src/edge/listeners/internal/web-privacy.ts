import type { Handlers } from "@lucent/rpc/mount";
import type { privacyContract } from "@lucent/rpc/web/privacy";
import { listBlocks, setBlock } from "../../../members/community/blocks.ts";
import { exportOwnData } from "../../../members/community/export.ts";
import { readShows, setShows, setVisibility } from "../../../members/community/profiles.ts";
import { listOwnRestrictions } from "../../../members/community/standing.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

// Blocks, last seen and visibility all decide who the presence roster names to whom; once one
// has committed the hub reads the roster afresh instead of waiting for the connected set to move.
function rosterAfter<T extends { readonly ok: boolean }>(ctx: WebRpcContext, result: T): T {
    if (result.ok) ctx.rosterChanged?.();
    return result;
}

export const privacyHandlers = {
    "privacy.restrictions.list": async (ctx, _input, { session }) =>
        served(await listOwnRestrictions(ctx.auth.db, session)),
    "privacy.blocks.list": async (ctx, _input, { session }) =>
        served(await listBlocks(ctx.auth.db, session)),
    "privacy.blocks.set": async (ctx, input, { session }) =>
        served(done(rosterAfter(ctx, await setBlock(ctx.auth.db, session, input)))),
    "privacy.shows.get": async (ctx, _input, { session }) =>
        served(await readShows(ctx.auth.db, session)),
    "privacy.shows.set": async (ctx, input, { session }) =>
        served(done(rosterAfter(ctx, await setShows(ctx.auth.db, session, input)))),
    "privacy.visibility.set": async (ctx, input, { session }) =>
        served(done(rosterAfter(ctx, await setVisibility(ctx.auth.db, session, input)))),
    "privacy.export.read": async (ctx, _input, { session }) =>
        served(await exportOwnData(ctx.auth.db, session)),
} satisfies Handlers<WebRpcContext, typeof privacyContract>;
