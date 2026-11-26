import type { Handlers } from "@lucent/rpc/mount";
import type { profileContract } from "@lucent/rpc/web/profile";
import { clearAvatar } from "../../../members/community/avatars.ts";
import { readProfile, setBio } from "../../../members/community/profiles.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const profileHandlers = {
    "profile.get": async (ctx, input, { session }) =>
        served(await readProfile(ctx.auth.db, session, input)),
    "profile.bio.set": async (ctx, input, { session }) =>
        served(done(await setBio(ctx.auth.db, session, input))),
    "profile.avatar.clear": async (ctx, _input, { session }) =>
        served(done(await clearAvatar(ctx.auth.db, session))),
} satisfies Handlers<WebRpcContext, typeof profileContract>;
