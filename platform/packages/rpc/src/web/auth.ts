import { AccountId, BearerToken, EpochMs, SessionId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import {
    AuthenticationResponse,
    CreationOptions,
    RegistrationResponse,
    RequestOptions,
} from "../webauthn.ts";
import { Done, refusal, SessionRefusal, SessionRefusals, Unavailable, Username } from "./shared.ts";

const SignInRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("FLOW_INVALID"),
    refusal("PASSKEY_REJECTED"),
    refusal("INVALID_CREDENTIALS"),
    refusal("ACCOUNT_UNAVAILABLE"),
    refusal("NO_SECOND_FACTOR"),
]);

const SetupRefusal = z.discriminatedUnion("code", [
    Unavailable,
    ...SessionRefusals,
    z.object({ code: z.literal("INVALID_USERNAME"), detail: z.string() }),
    refusal("SETUP_INVALID"),
    refusal("USERNAME_ALREADY_SET"),
    refusal("USERNAME_TAKEN"),
]);

const CredentialRefusal = z.discriminatedUnion("code", [
    Unavailable,
    ...SessionRefusals,
    refusal("FLOW_INVALID"),
    refusal("PASSKEY_REJECTED"),
    z.object({ code: z.literal("PASSWORD_REJECTED"), reason: z.enum(["too_short", "too_long"]) }),
    refusal("PASSWORD_BREACHED"),
    refusal("NOT_FOUND"),
    refusal("LAST_CREDENTIAL"),
    refusal("USERNAME_REQUIRED"),
    refusal("TOTP_ALREADY_ENROLLED"),
    refusal("TOTP_NOT_PENDING"),
    refusal("TOTP_CODE_INVALID"),
    refusal("NO_PASSKEY"),
]);

const SessionPurpose = z.enum(["member", "setup"]);

const Password = z.string().min(1).max(1_024);

const TotpCode = z.string().max(16);

const PasskeyId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,1366}$/)
    .refine((value) => value.length % 4 !== 1, "not base64url");

const SignedIn = z.object({ sessionToken: BearerToken, expiresAt: EpochMs });

const PasskeyChallenge = z.object({ flowToken: BearerToken, options: RequestOptions });

export const authContract = defineContract({
    "signIn.password": {
        session: "none",
        effect: "write",
        input: z.strictObject({ username: Username, password: Password }),
        // "signedIn" only from a dev server with LUCENT_DEV_PASSWORD_ONLY.
        output: z.discriminatedUnion("next", [
            z.object({
                next: z.literal("secondFactor"),
                flowToken: BearerToken,
                secondFactors: z.array(z.enum(["totp", "passkey"])).readonly(),
            }),
            SignedIn.extend({ next: z.literal("signedIn") }),
        ]),
        error: SignInRefusal,
    },
    "signIn.totp": {
        session: "none",
        effect: "write",
        input: z.strictObject({ flowToken: BearerToken, code: TotpCode }),
        output: SignedIn,
        error: SignInRefusal,
    },
    "signIn.passkey.begin": {
        session: "none",
        effect: "write",
        input: z.strictObject({ flowToken: BearerToken.nullable() }),
        output: PasskeyChallenge,
        error: SignInRefusal,
    },
    "signIn.passkey.finish": {
        session: "none",
        effect: "write",
        input: z.strictObject({ flowToken: BearerToken, response: AuthenticationResponse }),
        output: SignedIn,
        error: SignInRefusal,
    },

    "session.resolve": {
        session: "either",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            sessionId: SessionId,
            accountId: AccountId,
            username: z.string().nullable(),
            purpose: SessionPurpose,
            expiresAt: EpochMs,
            stepUpAt: EpochMs.nullable(),
            // Strings, not the Action enum: a permission added a deploy ahead of web must not make
            // every page fail to parse the viewer. Web keeps the ones it knows.
            standing: z.object({
                isRoot: z.boolean(),
                maxRank: z.number().int().nonnegative(),
                permissions: z.array(z.string()).readonly(),
            }),
        }),
        error: SessionRefusal,
    },
    "session.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            sessions: z
                .array(
                    z.object({
                        sessionId: SessionId,
                        purpose: SessionPurpose,
                        createdAt: EpochMs,
                        lastSeenAt: EpochMs,
                        expiresAt: EpochMs,
                        client: z.object({
                            ip: z.string().nullable(),
                            userAgent: z.string().nullable(),
                        }),
                        current: z.boolean(),
                    }),
                )
                .readonly(),
        }),
        error: SessionRefusal,
    },
    // Without a `sessionId`, the session making the call; with one, another of the holder's own,
    // which takes a member session.
    "session.end": {
        session: "either",
        effect: "write",
        input: z.strictObject({ sessionId: SessionId.nullable() }),
        output: Done,
        error: SessionRefusal,
    },
    "session.endOthers": {
        session: "member",
        effect: "write",
        input: z.strictObject({}),
        output: Done,
        error: SessionRefusal,
    },

    "setup.redeem": {
        session: "none",
        effect: "write",
        input: z.strictObject({ setupToken: BearerToken }),
        output: z.object({
            sessionToken: BearerToken,
            expiresAt: EpochMs,
            needsUsername: z.boolean(),
        }),
        error: SetupRefusal,
    },
    "setup.username.choose": {
        session: "setup",
        effect: "write",
        input: z.strictObject({ username: Username }),
        output: z.object({ username: z.string() }),
        error: SetupRefusal,
    },

    "credentials.list": {
        session: "either",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            passkeys: z
                .array(
                    z.object({
                        id: z.string(),
                        label: z.string(),
                        backedUp: z.boolean(),
                        createdAt: EpochMs,
                        lastUsedAt: EpochMs.nullable(),
                    }),
                )
                .readonly(),
            password: z.object({ updatedAt: EpochMs }).nullable(),
            totp: z.object({ confirmed: z.boolean() }).nullable(),
        }),
        error: CredentialRefusal,
    },
    "credentials.password.set": {
        session: "either",
        effect: "write",
        input: z.strictObject({ password: Password }),
        output: Done,
        error: CredentialRefusal,
    },
    "credentials.totp.enroll": {
        session: "either",
        effect: "write",
        input: z.strictObject({}),
        output: z.object({ uri: z.string(), secret: z.string() }),
        error: CredentialRefusal,
    },
    "credentials.totp.confirm": {
        session: "either",
        effect: "write",
        input: z.strictObject({ code: TotpCode }),
        output: Done,
        error: CredentialRefusal,
    },
    "credentials.passkey.register.begin": {
        session: "either",
        effect: "write",
        input: z.strictObject({}),
        output: z.object({ flowToken: BearerToken, options: CreationOptions }),
        error: CredentialRefusal,
    },
    "credentials.passkey.register.finish": {
        session: "either",
        effect: "write",
        input: z.strictObject({
            flowToken: BearerToken,
            label: z.string().trim().min(1).max(64),
            response: RegistrationResponse,
        }),
        output: z.object({ id: z.string() }),
        error: CredentialRefusal,
    },
    "credentials.remove": {
        session: "either",
        effect: "write",
        input: z.strictObject({
            credential: z.discriminatedUnion("kind", [
                z.strictObject({ kind: z.literal("passkey"), id: PasskeyId }),
                z.strictObject({ kind: z.literal("password") }),
                z.strictObject({ kind: z.literal("totp") }),
            ]),
        }),
        output: Done,
        error: CredentialRefusal,
    },

    "stepUp.begin": {
        session: "member",
        effect: "write",
        input: z.strictObject({}),
        output: PasskeyChallenge,
        error: CredentialRefusal,
    },
    "stepUp.finish": {
        session: "member",
        effect: "write",
        input: z.strictObject({ flowToken: BearerToken, response: AuthenticationResponse }),
        output: z.object({ stepUpAt: EpochMs }),
        error: CredentialRefusal,
    },
});
