import { ProductId } from "@lucent/core/scalars";
import type { Handlers } from "@lucent/rpc/mount";
import type { profileContract } from "@lucent/rpc/web/profile";
import { clearAvatar, clearBanner } from "../../../members/community/avatars.ts";
import { readProfile, setBio, setTagline } from "../../../members/community/profiles.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const profileHandlers = {
    "profile.get": async (ctx, input, { session }) =>
        served(
            await readProfile(ctx.auth.db, session, {
                username: input.username,
                present: ctx.presentOnline ?? (() => false),
                productName: (id) => ctx.catalog.get(ProductId.parse(id))?.name ?? null,
            }),
        ),
    "profile.tagline.set": async (ctx, input, { session }) =>
        served(done(await setTagline(ctx.auth.db, session, input))),
    "profile.banner.clear": async (ctx, _input, { session }) =>
        served(done(await clearBanner(ctx.auth.db, session))),
    "profile.bio.set": async (ctx, input, { session }) =>
        served(done(await setBio(ctx.auth.db, session, input))),
    "profile.avatar.clear": async (ctx, _input, { session }) =>
        served(done(await clearAvatar(ctx.auth.db, session))),
} satisfies Handlers<WebRpcContext, typeof profileContract>;
