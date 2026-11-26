import type { Handlers } from "@lucent/rpc/mount";
import type { deletionContract } from "@lucent/rpc/web/deletion";
import {
    cancelDeletion,
    readDeletion,
    requestDeletion,
} from "../../../identity/deletion/deletion.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

export const deletionHandlers = {
    "deletion.request.read": async (ctx, _input, { session }) =>
        served(await readDeletion(ctx.auth.db, { token: session, purpose: "member" })),
    "deletion.request.create": async (ctx, _input, { session, client }) =>
        served(await requestDeletion(ctx.auth, { token: session, purpose: "member", client })),
    "deletion.request.cancel": async (ctx, _input, { session, client }) =>
        served(
            done(await cancelDeletion(ctx.auth.db, { token: session, purpose: "member", client })),
        ),
    "appeals.deletion.read": async (ctx, _input, { session }) =>
        served(await readDeletion(ctx.auth.db, { token: session, purpose: "appeal" })),
    "appeals.deletion.request": async (ctx, _input, { session, client }) =>
        served(await requestDeletion(ctx.auth, { token: session, purpose: "appeal", client })),
    "appeals.deletion.cancel": async (ctx, _input, { session, client }) =>
        served(
            done(await cancelDeletion(ctx.auth.db, { token: session, purpose: "appeal", client })),
        ),
} satisfies Handlers<WebRpcContext, typeof deletionContract>;
