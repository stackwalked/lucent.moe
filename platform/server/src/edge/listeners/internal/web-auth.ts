import { ok } from "@lucent/core/result";
import type { ClientInfo } from "@lucent/core/scalars";
import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import {
    beginPasskeyRegistration,
    beginStepUp,
    beginTotpEnrollment,
    confirmTotpEnrollment,
    finishPasskeyRegistration,
    finishStepUp,
    listCredentials,
    removeCredential,
    setPassword,
} from "../../../identity/auth/credentials.ts";
import {
    redeemPasswordReset,
    requestPasswordReset,
} from "../../../identity/auth/password-reset.ts";
import {
    listSessions,
    signOut,
    signOutOthers,
    signOutSession,
} from "../../../identity/auth/sessions.ts";
import { chooseUsername, redeemSetupLink } from "../../../identity/auth/setup.ts";
import {
    beginPasskeySignIn,
    finishPasskeySignIn,
    signInWithPassword,
    signInWithTotp,
} from "../../../identity/auth/sign-in.ts";
import { resolveViewer } from "../../../identity/auth/viewer.ts";
import { done, served, type WebRpcContext } from "./web-shared.ts";

// Domain functions take the client as an optional field, absent when unknown.
function from(call: { readonly client: ClientInfo | null }): { readonly client?: ClientInfo } {
    return call.client === null ? {} : { client: call.client };
}

export const authHandlers = {
    "reset.password.request": async (ctx, input) =>
        served(done(await requestPasswordReset(ctx.auth, input.email))),
    "reset.password.redeem": async (ctx, input) =>
        served(done(await redeemPasswordReset(ctx.auth, input))),
    "signIn.password": async (ctx, input, call) =>
        served(await signInWithPassword(ctx.auth, { ...input, ...from(call) })),
    "signIn.totp": async (ctx, input, call) =>
        served(await signInWithTotp(ctx.auth, { ...input, ...from(call) })),
    "signIn.passkey.begin": async (ctx, input) => served(await beginPasskeySignIn(ctx.auth, input)),
    "signIn.passkey.finish": async (ctx, input, call) =>
        served(await finishPasskeySignIn(ctx.auth, { ...input, ...from(call) })),

    "session.resolve": async (ctx, _input, { session, client }) =>
        served(
            await resolveViewer(ctx.auth.db, {
                sessionToken: session,
                client,
                stepUpWaived: ctx.auth.passwordOnly === true,
            }),
        ),
    "session.list": async (ctx, _input, { session }) => {
        const listed = await listSessions(ctx.auth.db, { sessionToken: session });
        return served(listed.ok ? ok({ sessions: listed.value }) : listed);
    },
    "session.end": async (ctx, input, { session }) =>
        served(
            done(
                input.sessionId === null
                    ? await signOut(ctx.auth.db, { sessionToken: session })
                    : await signOutSession(ctx.auth.db, {
                          sessionToken: session,
                          sessionId: input.sessionId,
                      }),
            ),
        ),
    "session.endOthers": async (ctx, _input, { session }) =>
        served(done(await signOutOthers(ctx.auth.db, { sessionToken: session }))),

    "setup.redeem": async (ctx, input, call) =>
        served(await redeemSetupLink(ctx.auth, { ...input, ...from(call) })),
    "setup.username.choose": async (ctx, input, call) =>
        served(
            await chooseUsername(ctx.auth, {
                sessionToken: call.session,
                username: input.username,
                ...from(call),
            }),
        ),

    "credentials.list": async (ctx, _input, { session }) =>
        served(await listCredentials(ctx.auth, { sessionToken: session })),
    "credentials.password.set": async (ctx, input, call) =>
        served(
            done(
                await setPassword(ctx.auth, {
                    sessionToken: call.session,
                    password: input.password,
                    ...from(call),
                }),
            ),
        ),
    "credentials.totp.enroll": async (ctx, _input, { session }) =>
        served(await beginTotpEnrollment(ctx.auth, { sessionToken: session })),
    "credentials.totp.confirm": async (ctx, input, call) =>
        served(
            done(
                await confirmTotpEnrollment(ctx.auth, {
                    sessionToken: call.session,
                    code: input.code,
                    ...from(call),
                }),
            ),
        ),
    "credentials.passkey.register.begin": async (ctx, _input, { session }) =>
        served(await beginPasskeyRegistration(ctx.auth, { sessionToken: session })),
    "credentials.passkey.register.finish": async (ctx, input, call) =>
        served(
            await finishPasskeyRegistration(ctx.auth, {
                sessionToken: call.session,
                ...input,
                ...from(call),
            }),
        ),
    "credentials.remove": async (ctx, input, call) => {
        const credential = input.credential;
        const removed = await removeCredential(ctx.auth, {
            sessionToken: call.session,
            credential:
                credential.kind === "passkey"
                    ? {
                          kind: "passkey",
                          id: Uint8Array.fromBase64(credential.id, { alphabet: "base64url" }),
                      }
                    : credential,
            ...from(call),
        });
        return served(done(removed));
    },

    "stepUp.begin": async (ctx, _input, { session }) =>
        served(await beginStepUp(ctx.auth, { sessionToken: session })),
    "stepUp.finish": async (ctx, input, { session }) =>
        served(await finishStepUp(ctx.auth, { sessionToken: session, ...input })),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
