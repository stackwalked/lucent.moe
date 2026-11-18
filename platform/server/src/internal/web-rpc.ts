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
} from "../auth/credentials.ts";
import type { AuthDeps } from "../auth/deps.ts";
import { resolveSession, signOut, signOutOthers } from "../auth/sessions.ts";
import { chooseUsername, redeemSetupLink } from "../auth/setup.ts";
import {
    beginPasskeySignIn,
    finishPasskeySignIn,
    signInWithPassword,
    signInWithTotp,
} from "../auth/sign-in.ts";
import { type WebContract, webContract } from "../contract/web.ts";
import { err, ok, type Result } from "../core/result.ts";
import { type Handlers, implement } from "../core/rpc.ts";
import type { DbFailure } from "../db/pool.ts";
import type { ProductCatalog } from "../products/catalog.ts";

export type WebRpcContext = {
    readonly catalog: ProductCatalog;
    readonly auth: AuthDeps;
};

type Unavailable = { readonly code: "SERVICE_UNAVAILABLE" };

const DB_FAILURE_CODES: ReadonlySet<string> = new Set([
    "STATEMENT_TIMEOUT",
    "SERIALIZATION_FAILURE",
    "UNIQUE_VIOLATION",
    "CHECK_VIOLATION",
    "DB_UNAVAILABLE",
]);

function isServable<E extends { readonly code: string }>(error: E): error is Exclude<E, DbFailure> {
    return !DB_FAILURE_CODES.has(error.code);
}

// A database failure is the server being unavailable, as far as web is concerned; the detail
// stays out of the reply.
function served<T, E extends { readonly code: string }>(
    result: Result<T, E>,
): Result<T, Exclude<E, DbFailure> | Unavailable> {
    if (result.ok) return result;
    if (isServable(result.error)) return err(result.error);
    return err({ code: "SERVICE_UNAVAILABLE" });
}

function done<E>(result: Result<void, E>): Result<Record<string, never>, E> {
    return result.ok ? ok({}) : result;
}

const handlers: Handlers<WebRpcContext, WebContract> = {
    "health.check": (ctx) => Promise.resolve(ok({ productsLoaded: ctx.catalog.size })),
    "catalog.list": (ctx) => Promise.resolve(ok([...ctx.catalog.values()])),

    "signIn.password": async (ctx, input) => served(await signInWithPassword(ctx.auth, input)),
    "signIn.totp": async (ctx, input) => served(await signInWithTotp(ctx.auth, input)),
    "signIn.passkey.begin": async (ctx, input) => served(await beginPasskeySignIn(ctx.auth, input)),
    "signIn.passkey.finish": async (ctx, input) =>
        served(await finishPasskeySignIn(ctx.auth, input)),

    "session.resolve": async (ctx, _input, session) =>
        served(await resolveSession(ctx.auth.db, { sessionToken: session })),
    "session.end": async (ctx, _input, session) =>
        served(done(await signOut(ctx.auth.db, { sessionToken: session }))),
    "session.endOthers": async (ctx, _input, session) =>
        served(done(await signOutOthers(ctx.auth.db, { sessionToken: session }))),

    "setup.redeem": async (ctx, input) => served(await redeemSetupLink(ctx.auth, input)),
    "setup.username.choose": async (ctx, input, session) =>
        served(await chooseUsername(ctx.auth, { sessionToken: session, username: input.username })),

    "credentials.list": async (ctx, _input, session) =>
        served(await listCredentials(ctx.auth, { sessionToken: session })),
    "credentials.password.set": async (ctx, input, session) =>
        served(
            done(await setPassword(ctx.auth, { sessionToken: session, password: input.password })),
        ),
    "credentials.totp.enroll": async (ctx, _input, session) =>
        served(await beginTotpEnrollment(ctx.auth, { sessionToken: session })),
    "credentials.totp.confirm": async (ctx, input, session) =>
        served(
            done(
                await confirmTotpEnrollment(ctx.auth, { sessionToken: session, code: input.code }),
            ),
        ),
    "credentials.passkey.register.begin": async (ctx, _input, session) =>
        served(await beginPasskeyRegistration(ctx.auth, { sessionToken: session })),
    "credentials.passkey.register.finish": async (ctx, input, session) =>
        served(await finishPasskeyRegistration(ctx.auth, { sessionToken: session, ...input })),
    "credentials.remove": async (ctx, input, session) => {
        const credential = input.credential;
        const removed = await removeCredential(ctx.auth, {
            sessionToken: session,
            credential:
                credential.kind === "passkey"
                    ? {
                          kind: "passkey",
                          id: Uint8Array.fromBase64(credential.id, { alphabet: "base64url" }),
                      }
                    : credential,
        });
        return served(done(removed));
    },

    "stepUp.begin": async (ctx, _input, session) =>
        served(await beginStepUp(ctx.auth, { sessionToken: session })),
    "stepUp.finish": async (ctx, input, session) =>
        served(await finishStepUp(ctx.auth, { sessionToken: session, ...input })),
};

export const webProcedures = implement(webContract, handlers);
