import { ProductDefinition } from "@lucent/catalog/catalog";
import {
    AccountId,
    BearerToken,
    EpochMs,
    OperationId,
    RoleId,
    SessionId,
} from "@lucent/core/scalars";
import { ActionSchema } from "@lucent/policy/actions";
import { z } from "zod";
import { defineContract } from "./contract.ts";
import {
    AuthenticationResponse,
    CreationOptions,
    RegistrationResponse,
    RequestOptions,
} from "./webauthn.ts";

// What web may ask platform, and what each answer can be. Inputs are strict; outputs and refusals
// are `z.object`, which drops fields it doesn't know, so platform can add one a deploy before web
// reads it. A procedure's `session` names who may call it; the token travels in `Lucent-Session`.

function refusal<const Code extends string>(code: Code) {
    return z.object({ code: z.literal(code) });
}

const Unavailable = refusal("SERVICE_UNAVAILABLE");

const SessionRefusals = [
    refusal("SESSION_INVALID"),
    z.object({ code: z.literal("REAUTH_REQUIRED"), withinSeconds: z.number() }),
] as const;

const SignInRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("FLOW_INVALID"),
    refusal("PASSKEY_REJECTED"),
    refusal("INVALID_CREDENTIALS"),
    refusal("ACCOUNT_UNAVAILABLE"),
    refusal("NO_SECOND_FACTOR"),
]);

const SessionRefusal = z.discriminatedUnion("code", [Unavailable, ...SessionRefusals]);

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
    refusal("NOT_FOUND"),
    refusal("LAST_CREDENTIAL"),
    refusal("USERNAME_REQUIRED"),
    refusal("TOTP_ALREADY_ENROLLED"),
    refusal("TOTP_NOT_PENDING"),
    refusal("TOTP_CODE_INVALID"),
    refusal("NO_PASSKEY"),
]);

const Done = z.object({});

// Admin procedures run as a member session's account; `can()` decides, under the step-up rule.
const StaffRefusals = [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("FORBIDDEN"),
    z.object({ code: z.literal("STEP_UP_REQUIRED"), withinSeconds: z.number() }),
] as const;
const ReadRefusal = z.discriminatedUnion("code", [
    ...StaffRefusals,
    refusal("NOT_FOUND"),
    refusal("INVALID_CURSOR"),
]);
// A receipt-backed write reused with different input: the form's operationId went stale.
const Reused = refusal("IDEMPOTENCY_CONFLICT");

// "setup_pending": no way to sign in yet (no passkey, and not both a password and confirmed
// TOTP), whether new or recovered.
export const AccountStatus = z.enum(["active", "suspended", "locked", "setup_pending"]);
export type AccountStatus = z.output<typeof AccountStatus>;

const Cursor = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
function pageOf<Item extends z.ZodType>(item: Item) {
    return z.object({ items: z.array(item).readonly(), nextCursor: z.string().nullable() });
}

const AccountSummary = z.object({
    accountId: AccountId,
    email: z.string(),
    username: z.string().nullable(),
    status: AccountStatus,
    isRoot: z.boolean(),
    createdAt: EpochMs,
    lastSeenAt: EpochMs.nullable(),
    roles: z.array(z.string()).readonly(),
});

// `operation` and `detail` stay open: rows outlive the code that wrote them.
const AuditEntry = z.object({
    id: z.string(),
    at: EpochMs,
    actor: z.object({ id: z.string(), username: z.string().nullable() }),
    operation: z.string(),
    target: z.object({
        accountId: AccountId.nullable(),
        username: z.string().nullable(),
        detail: z.record(z.string(), z.unknown()),
    }),
});

const RoleSummary = z.object({
    roleId: RoleId,
    name: z.string(),
    rank: z.number().int(),
    permissions: z.array(z.string()).readonly(),
    unknownPermissions: z.array(z.string()).readonly(),
    holders: z.number().int(),
});
const SessionPurpose = z.enum(["member", "setup"]);
const Password = z.string().min(1).max(1_024);
const TotpCode = z.string().max(16);
const Username = z.string().max(64);
const PasskeyId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,1366}$/)
    .refine((value) => value.length % 4 !== 1, "not base64url");

const SignedIn = z.object({ sessionToken: BearerToken, expiresAt: EpochMs });
const PasskeyChallenge = z.object({ flowToken: BearerToken, options: RequestOptions });

export const webContract = defineContract({
    "health.check": {
        session: "none",
        input: z.strictObject({}),
        output: z.object({ productsLoaded: z.number().int().nonnegative() }),
        error: z.never(),
    },
    "catalog.list": {
        session: "none",
        input: z.strictObject({}),
        output: z.array(ProductDefinition).readonly(),
        error: z.never(),
    },

    "signIn.password": {
        session: "none",
        input: z.strictObject({ username: Username, password: Password }),
        output: z.object({
            flowToken: BearerToken,
            secondFactors: z.array(z.enum(["totp", "passkey"])).readonly(),
        }),
        error: SignInRefusal,
    },
    "signIn.totp": {
        session: "none",
        input: z.strictObject({ flowToken: BearerToken, code: TotpCode }),
        output: SignedIn,
        error: SignInRefusal,
    },
    "signIn.passkey.begin": {
        session: "none",
        input: z.strictObject({ flowToken: BearerToken.nullable() }),
        output: PasskeyChallenge,
        error: SignInRefusal,
    },
    "signIn.passkey.finish": {
        session: "none",
        input: z.strictObject({ flowToken: BearerToken, response: AuthenticationResponse }),
        output: SignedIn,
        error: SignInRefusal,
    },

    "session.resolve": {
        session: "either",
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
        input: z.strictObject({ sessionId: SessionId.nullable() }),
        output: Done,
        error: SessionRefusal,
    },
    "session.endOthers": {
        session: "member",
        input: z.strictObject({}),
        output: Done,
        error: SessionRefusal,
    },

    "setup.redeem": {
        session: "none",
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
        input: z.strictObject({ username: Username }),
        output: z.object({ username: z.string() }),
        error: SetupRefusal,
    },

    "credentials.list": {
        session: "either",
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
        input: z.strictObject({ password: Password }),
        output: Done,
        error: CredentialRefusal,
    },
    "credentials.totp.enroll": {
        session: "either",
        input: z.strictObject({}),
        output: z.object({ uri: z.string(), secret: z.string() }),
        error: CredentialRefusal,
    },
    "credentials.totp.confirm": {
        session: "either",
        input: z.strictObject({ code: TotpCode }),
        output: Done,
        error: CredentialRefusal,
    },
    "credentials.passkey.register.begin": {
        session: "either",
        input: z.strictObject({}),
        output: z.object({ flowToken: BearerToken, options: CreationOptions }),
        error: CredentialRefusal,
    },
    "credentials.passkey.register.finish": {
        session: "either",
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
        input: z.strictObject({}),
        output: PasskeyChallenge,
        error: CredentialRefusal,
    },
    "stepUp.finish": {
        session: "member",
        input: z.strictObject({ flowToken: BearerToken, response: AuthenticationResponse }),
        output: z.object({ stepUpAt: EpochMs }),
        error: CredentialRefusal,
    },

    "admin.accounts.list": {
        session: "member",
        input: z.strictObject({
            filter: z.strictObject({
                status: AccountStatus.nullable(),
                roleId: RoleId.nullable(),
                text: z.string().trim().min(1).max(64).nullable(),
            }),
            sort: z.enum(["newest", "username"]),
            cursor: Cursor.nullable(),
        }),
        output: pageOf(AccountSummary),
        error: ReadRefusal,
    },
    "admin.accounts.get": {
        session: "member",
        input: z.strictObject({ accountId: AccountId }),
        output: AccountSummary.extend({
            signIn: z.object({
                passkeys: z.number().int(),
                password: z.boolean(),
                totp: z.boolean(),
            }),
            heldRoles: z
                .array(
                    z.object({
                        roleId: RoleId,
                        name: z.string(),
                        rank: z.number().int(),
                        permissions: z.array(z.string()).readonly(),
                        expiresAt: EpochMs.nullable(),
                    }),
                )
                .readonly(),
            recentAudit: z.array(AuditEntry).readonly().nullable(),
        }),
        error: ReadRefusal,
    },
    // The setup link is in this reply only; a replay has none (receipts hold no secrets).
    "admin.accounts.create": {
        session: "member",
        input: z.strictObject({ operationId: OperationId, email: z.email().max(254) }),
        output: z.object({ accountId: AccountId, setupToken: BearerToken.nullable() }),
        error: z.discriminatedUnion("code", [...StaffRefusals, Reused, refusal("EMAIL_TAKEN")]),
    },
    "admin.accounts.suspend": {
        session: "member",
        input: z.strictObject({
            operationId: OperationId,
            accountId: AccountId,
            reason: z.string().trim().min(1).max(500),
        }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, Reused, refusal("NOT_FOUND")]),
    },
    "admin.accounts.reinstate": {
        session: "member",
        input: z.strictObject({ operationId: OperationId, accountId: AccountId }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, Reused, refusal("NOT_FOUND")]),
    },
    "admin.accounts.rename": {
        session: "member",
        input: z.strictObject({
            operationId: OperationId,
            accountId: AccountId,
            username: Username,
        }),
        output: z.object({ username: z.string() }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            Reused,
            refusal("NOT_FOUND"),
            z.object({ code: z.literal("INVALID_USERNAME"), detail: z.string() }),
            refusal("USERNAME_TAKEN"),
        ]),
    },
    // Not receipt-backed: every call wipes the account's ways in and issues a fresh link.
    "admin.accounts.recover": {
        session: "member",
        input: z.strictObject({ accountId: AccountId }),
        output: z.object({ setupToken: BearerToken }),
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },

    "admin.roles.list": {
        session: "member",
        input: z.strictObject({}),
        output: z.object({ roles: z.array(RoleSummary).readonly() }),
        error: ReadRefusal,
    },
    "admin.roles.get": {
        session: "member",
        input: z.strictObject({ roleId: RoleId }),
        output: RoleSummary,
        error: ReadRefusal,
    },
    // Creates or rewrites a role. Channel grants aren't edited here and stay as they are.
    "admin.roles.save": {
        session: "member",
        input: z.strictObject({
            operationId: OperationId,
            roleId: RoleId,
            name: z.string().trim().min(1).max(64),
            rank: z.number().int().nonnegative(),
            permissions: z.array(ActionSchema).max(64),
        }),
        output: z.object({ roleId: RoleId }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            Reused,
            refusal("INVALID_RANK"),
            refusal("ROLE_NAME_TAKEN"),
        ]),
    },
    "admin.roles.assign": {
        session: "member",
        input: z.strictObject({
            accountId: AccountId,
            roleId: RoleId,
            expiresAt: EpochMs.nullable(),
        }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },
    "admin.roles.unassign": {
        session: "member",
        input: z.strictObject({ accountId: AccountId, roleId: RoleId }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },

    "admin.audit.list": {
        session: "member",
        input: z.strictObject({
            filter: z.strictObject({
                actorId: z.string().max(64).nullable(),
                targetAccountId: AccountId.nullable(),
                operation: z.string().max(64).nullable(),
                before: EpochMs.nullable(),
            }),
            cursor: Cursor.nullable(),
        }),
        output: pageOf(AuditEntry),
        error: ReadRefusal,
    },
});

export type WebContract = typeof webContract;
