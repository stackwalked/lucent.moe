import type { Handlers } from "@lucent/rpc/mount";
import type { profileContract } from "@lucent/rpc/web/profile";
import { readProfile, setBio } from "../../community/profiles.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const profileHandlers = {
    "profile.get": async (ctx, input, { session }) =>
        served(await readProfile(ctx.auth.db, session, input)),
    "profile.bio.set": async (ctx, input, { session }) =>
        served(done(await setBio(ctx.auth.db, session, input))),
} satisfies Handlers<WebRpcContext, typeof profileContract>;
