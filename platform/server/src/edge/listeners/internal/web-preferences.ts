import type { Handlers } from "@lucent/rpc/mount";
import type { preferencesContract } from "@lucent/rpc/web/preferences";
import {
    listPreferences,
    setPreference,
    setSubscription,
} from "../../../members/notify/preferences.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const preferencesHandlers = {
    "preferences.channels.list": async (ctx, _input, { session }) =>
        served(await listPreferences(ctx.auth.db, session, ctx.catalog)),
    "preferences.channels.set": async (ctx, input, { session }) =>
        served(done(await setPreference(ctx.auth.db, session, input))),
    "preferences.subscriptions.set": async (ctx, input, { session }) =>
        served(
            done(await setSubscription(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
        ),
} satisfies Handlers<WebRpcContext, typeof preferencesContract>;
