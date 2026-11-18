import type {
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
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
import { AuthenticationResponse, RegistrationResponse } from "../auth/passkeys.ts";
import { resolveSession, signOut, signOutOthers } from "../auth/sessions.ts";
import { chooseUsername, redeemSetupLink } from "../auth/setup.ts";
import {
    beginPasskeySignIn,
    finishPasskeySignIn,
    signInWithPassword,
    signInWithTotp,
} from "../auth/sign-in.ts";
import { BearerToken } from "../auth/tokens.ts";
import { err, ok, type Result } from "../core/result.ts";
import { procedure } from "../core/rpc.ts";
import { AccountId, EpochMs } from "../core/scalars.ts";
import type { DbFailure } from "../db/pool.ts";

export type AuthRpcContext = {
    readonly auth: AuthDeps;
};

function refusal<const Code extends string>(code: Code) {
    return z.strictObject({ code: z.literal(code) });
}

// A database failure is the server being unavailable, as far as web is concerned; the detail
// stays out of the reply.
const Unavailable = refusal("SERVICE_UNAVAILABLE");
type Unavailable = z.output<typeof Unavailable>;

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

const Done = z.strictObject({});
const SessionInput = z.strictObject({ session: BearerToken });
const RequestOptions = z.custom<PublicKeyCredentialRequestOptionsJSON>(
    (value) => typeof value === "object" && value !== null,
);
const CreationOptions = z.custom<PublicKeyCredentialCreationOptionsJSON>(
    (value) => typeof value === "object" && value !== null,
);
const SignedIn = z.strictObject({ sessionToken: BearerToken, expiresAt: EpochMs });
const FlowStarted = z.strictObject({ flowToken: BearerToken, options: RequestOptions });

const SessionRefusals = [
    refusal("SESSION_INVALID"),
    z.strictObject({ code: z.literal("REAUTH_REQUIRED"), withinSeconds: z.number() }),
] as const;

const SignInRefusals = [
    Unavailable,
    refusal("FLOW_INVALID"),
    refusal("PASSKEY_REJECTED"),
    refusal("INVALID_CREDENTIALS"),
    refusal("ACCOUNT_UNAVAILABLE"),
    refusal("NO_SECOND_FACTOR"),
] as const;
const SignInRefusal = z.discriminatedUnion("code", [...SignInRefusals]);

const CredentialRefusal = z.discriminatedUnion("code", [
    Unavailable,
    ...SessionRefusals,
    refusal("FLOW_INVALID"),
    refusal("PASSKEY_REJECTED"),
    z.strictObject({
        code: z.literal("PASSWORD_REJECTED"),
        reason: z.enum(["too_short", "too_long"]),
    }),
    refusal("NOT_FOUND"),
    refusal("LAST_CREDENTIAL"),
    refusal("USERNAME_REQUIRED"),
    refusal("TOTP_ALREADY_ENROLLED"),
    refusal("TOTP_NOT_PENDING"),
    refusal("TOTP_CODE_INVALID"),
    refusal("NO_PASSKEY"),
]);

const SetupRefusal = z.discriminatedUnion("code", [
    Unavailable,
    ...SessionRefusals,
    z.strictObject({ code: z.literal("INVALID_USERNAME"), detail: z.string() }),
    refusal("SETUP_INVALID"),
    refusal("USERNAME_ALREADY_SET"),
    refusal("USERNAME_TAKEN"),
]);

const SessionRefusal = z.discriminatedUnion("code", [Unavailable, ...SessionRefusals]);

const Base64Url = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,1366}$/)
    .refine((value) => value.length % 4 !== 1, "not base64url");

const CredentialRef = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("passkey"), id: Base64Url }),
    z.strictObject({ kind: z.literal("password") }),
    z.strictObject({ kind: z.literal("totp") }),
]);

const Password = z.string().min(1).max(1_024);
const TotpCode = z.string().max(16);

export const authRpc = {
    "auth.password": procedure({
        input: z.strictObject({ username: z.string().max(64), password: Password }),
        output: z.strictObject({
            flowToken: BearerToken,
            secondFactors: z.array(z.enum(["totp", "passkey"])).readonly(),
        }),
        error: SignInRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(await signInWithPassword(ctx.auth, input)),
    }),
    "auth.totp": procedure({
        input: z.strictObject({ flowToken: BearerToken, code: TotpCode }),
        output: SignedIn,
        error: SignInRefusal,
        run: async (ctx: AuthRpcContext, input) => served(await signInWithTotp(ctx.auth, input)),
    }),
    "auth.passkey.begin": procedure({
        input: z.strictObject({ flowToken: BearerToken.nullable() }),
        output: FlowStarted,
        error: SignInRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(await beginPasskeySignIn(ctx.auth, input)),
    }),
    "auth.passkey.finish": procedure({
        input: z.strictObject({ flowToken: BearerToken, response: AuthenticationResponse }),
        output: SignedIn,
        error: SignInRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(await finishPasskeySignIn(ctx.auth, input)),
    }),
    "session.resolve": procedure({
        input: SessionInput,
        output: z.strictObject({
            accountId: AccountId,
            purpose: z.enum(["member", "setup"]),
            expiresAt: EpochMs,
            stepUpAt: EpochMs.nullable(),
        }),
        error: SessionRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(await resolveSession(ctx.auth.db, { sessionToken: input.session })),
    }),
    "session.end": procedure({
        input: SessionInput,
        output: Done,
        error: SessionRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(done(await signOut(ctx.auth.db, { sessionToken: input.session }))),
    }),
    "session.endOthers": procedure({
        input: SessionInput,
        output: Done,
        error: SessionRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(done(await signOutOthers(ctx.auth.db, { sessionToken: input.session }))),
    }),
    "setup.redeem": procedure({
        input: z.strictObject({ setupToken: BearerToken }),
        output: z.strictObject({
            sessionToken: BearerToken,
            expiresAt: EpochMs,
            needsUsername: z.boolean(),
        }),
        error: SetupRefusal,
        run: async (ctx: AuthRpcContext, input) => served(await redeemSetupLink(ctx.auth, input)),
    }),
    "setup.username": procedure({
        input: z.strictObject({ session: BearerToken, username: z.string().max(64) }),
        output: z.strictObject({ username: z.string() }),
        error: SetupRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(
                await chooseUsername(ctx.auth, {
                    sessionToken: input.session,
                    username: input.username,
                }),
            ),
    }),
    "credentials.list": procedure({
        input: SessionInput,
        output: z.strictObject({
            passkeys: z
                .array(
                    z.strictObject({
                        id: z.string(),
                        label: z.string(),
                        backedUp: z.boolean(),
                        createdAt: EpochMs,
                        lastUsedAt: EpochMs.nullable(),
                    }),
                )
                .readonly(),
            password: z.strictObject({ updatedAt: EpochMs }).nullable(),
            totp: z.strictObject({ confirmed: z.boolean() }).nullable(),
        }),
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(await listCredentials(ctx.auth, { sessionToken: input.session })),
    }),
    "password.set": procedure({
        input: z.strictObject({ session: BearerToken, password: Password }),
        output: Done,
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(
                done(
                    await setPassword(ctx.auth, {
                        sessionToken: input.session,
                        password: input.password,
                    }),
                ),
            ),
    }),
    "totp.enroll": procedure({
        input: SessionInput,
        output: z.strictObject({ uri: z.string(), secret: z.string() }),
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(await beginTotpEnrollment(ctx.auth, { sessionToken: input.session })),
    }),
    "totp.confirm": procedure({
        input: z.strictObject({ session: BearerToken, code: TotpCode }),
        output: Done,
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(
                done(
                    await confirmTotpEnrollment(ctx.auth, {
                        sessionToken: input.session,
                        code: input.code,
                    }),
                ),
            ),
    }),
    "passkey.register.begin": procedure({
        input: SessionInput,
        output: z.strictObject({ flowToken: BearerToken, options: CreationOptions }),
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(await beginPasskeyRegistration(ctx.auth, { sessionToken: input.session })),
    }),
    "passkey.register.finish": procedure({
        input: z.strictObject({
            session: BearerToken,
            flowToken: BearerToken,
            label: z.string().trim().min(1).max(64),
            response: RegistrationResponse,
        }),
        output: z.strictObject({ id: z.string() }),
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(
                await finishPasskeyRegistration(ctx.auth, {
                    sessionToken: input.session,
                    flowToken: input.flowToken,
                    label: input.label,
                    response: input.response,
                }),
            ),
    }),
    "credential.remove": procedure({
        input: z.strictObject({ session: BearerToken, credential: CredentialRef }),
        output: Done,
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) => {
            const credential = input.credential;
            const removed = await removeCredential(ctx.auth, {
                sessionToken: input.session,
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
    }),
    "stepUp.begin": procedure({
        input: SessionInput,
        output: FlowStarted,
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(await beginStepUp(ctx.auth, { sessionToken: input.session })),
    }),
    "stepUp.finish": procedure({
        input: z.strictObject({
            session: BearerToken,
            flowToken: BearerToken,
            response: AuthenticationResponse,
        }),
        output: z.strictObject({ stepUpAt: EpochMs }),
        error: CredentialRefusal,
        run: async (ctx: AuthRpcContext, input) =>
            served(
                await finishStepUp(ctx.auth, {
                    sessionToken: input.session,
                    flowToken: input.flowToken,
                    response: input.response,
                }),
            ),
    }),
};
