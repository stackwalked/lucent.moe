import type { Handlers } from "@lucent/rpc/mount";
import type { profileContract } from "@lucent/rpc/web/profile";
import { clearAvatar, clearBanner } from "../../../members/community/avatars.ts";
import { readProfile, setBio } from "../../../members/community/profiles.ts";
import { createWallComment, deleteWallComment, listWall } from "../../../members/community/wall.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const profileHandlers = {
    "profile.get": async (ctx, input, { session }) =>
        served(
            await readProfile(ctx.auth.db, session, {
                username: input.username,
                present: ctx.presentOnline ?? (() => false),
                catalog: ctx.catalog,
            }),
        ),
    "profile.comments.list": async (ctx, input, { session }) =>
        served(await listWall(ctx.auth.db, session, input)),
    "profile.comments.create": async (ctx, input, { session }) =>
        served(await createWallComment(ctx.auth.db, session, input)),
    "profile.comments.delete": async (ctx, input, { session }) =>
        served(done(await deleteWallComment(ctx.auth.db, session, input))),
    "profile.banner.clear": async (ctx, _input, { session }) =>
        served(done(await clearBanner(ctx.auth.db, session))),
    "profile.bio.set": async (ctx, input, { session }) =>
        served(done(await setBio(ctx.auth.db, session, input))),
    "profile.avatar.clear": async (ctx, _input, { session }) =>
        served(done(await clearAvatar(ctx.auth.db, session))),
} satisfies Handlers<WebRpcContext, typeof profileContract>;
