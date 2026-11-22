import { ProductDefinition } from "@lucent/catalog/product";
import {
    AccountId,
    BearerToken,
    ChannelId,
    EntitlementId,
    EpochMs,
    FeatureTag,
    OperationId,
    ProductId,
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
    refusal("PASSWORD_BREACHED"),
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

// The native path's ids as web carries them: 16 bytes in lowercase hex, and the loader's pushed
// sign-in request as it appears in `/auth/device/<id>`.
const WireId = z.string().regex(/^[0-9a-f]{32}$/);
const SignInRequestId = z.string().regex(/^lauth_[A-Za-z0-9_-]{22}$/);
// The first 40 bits of the device key's thumbprint, `XXXX-XXXX` in Crockford base32.
const MatchCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
const KeyStorage = z.enum(["tpm", "software"]);
const LoopbackRedirect = z.object({ redirectTo: z.string().startsWith("http://127.0.0.1:") });
const DeviceRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
]);
const PasskeyChallenge = z.object({ flowToken: BearerToken, options: RequestOptions });
const DeviceName = z.string().trim().min(1).max(64);
// A live device as its owner and staff see it. `lastSeenAt` is the last lease a module running on
// it was given; null before its first start.
const Device = z.object({
    deviceId: WireId,
    name: z.string().nullable(),
    matchCode: MatchCode,
    storage: KeyStorage,
    enrolledAt: EpochMs,
    lastSeenAt: EpochMs.nullable(),
});
// When the member may next replace or remove a device themselves; null when they may now.
const DeviceWindow = EpochMs.nullable();
const Features = z.union([z.literal("*"), z.array(FeatureTag).readonly()]);
const ProductGrant = z.object({
    productId: ProductId,
    features: Features,
    channels: z.array(ChannelId).readonly(),
});
const Entitlement = z.object({
    entitlementId: EntitlementId,
    status: z.enum(["active", "suspended", "revoked"]),
    validFrom: EpochMs,
    validUntil: EpochMs.nullable(),
    createdAt: EpochMs,
    products: z.array(ProductGrant).readonly(),
});

// The internal listener's streaming route for the current loader's bytes: a GET with the peer
// key and `Lucent-Session`, answered with the bytes, or a refusal as JSON (401 SESSION_INVALID,
// 404 NOT_FOUND when `download.loader` isn't "ready", 503).
export const LOADER_DOWNLOAD_PATH = "/internal/web/downloads/loader";

// Seal numbers are u64 on the wire and bigint in the database: decimal strings, past JSON's safe
// integers.
const SealNumber = z.string().regex(/^[1-9][0-9]{0,18}$/);
const ReleaseLine = z.object({
    productId: ProductId,
    name: z.string(),
    kind: z.string(),
    channel: ChannelId,
    current: z.object({ number: SealNumber, promotedAt: EpochMs }).nullable(),
    seals: z
        .array(z.object({ number: SealNumber, releaseId: WireId, stagedAt: EpochMs }))
        .readonly(),
});
const FactSetId = z.string().regex(/^[1-9][0-9]{0,18}$/);
// A game module build: its name hash as 16 hex digits, TimeDateStamp and SizeOfImage.
const ModuleBuild = z.object({
    nameHash: z.string().regex(/^[0-9a-f]{16}$/),
    timeDateStamp: z.number().int().nonnegative(),
    sizeOfImage: z.number().int().nonnegative(),
});

export const webContract = defineContract({
    "health.check": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ productsLoaded: z.number().int().nonnegative() }),
        error: z.never(),
    },
    "catalog.list": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.array(ProductDefinition).readonly(),
        error: z.never(),
    },

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

    // The browser half of the loader's sign-in: web shows the code the loader shows, and on
    // approval or denial sends the browser to `redirectTo`, the loader's loopback listener.
    "devices.signIn.read": {
        session: "member",
        effect: "read",
        input: z.strictObject({ requestId: SignInRequestId }),
        output: z.object({
            requestId: z.string(),
            matchCode: MatchCode,
            createdAt: EpochMs,
            expiresAt: EpochMs,
        }),
        error: DeviceRefusal,
    },
    "devices.signIn.approve": {
        session: "member",
        effect: "write",
        input: z.strictObject({ requestId: SignInRequestId }),
        output: LoopbackRedirect,
        error: DeviceRefusal,
    },
    "devices.signIn.deny": {
        session: "member",
        effect: "write",
        input: z.strictObject({ requestId: SignInRequestId }),
        output: LoopbackRedirect,
        error: DeviceRefusal,
    },
    // PCs waiting for the member to confirm them, each with the code its loader shows.
    "devices.enrollments.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            enrollments: z
                .array(
                    z.object({
                        enrollmentId: WireId,
                        matchCode: MatchCode,
                        storage: KeyStorage,
                        createdAt: EpochMs,
                        expiresAt: EpochMs,
                    }),
                )
                .readonly(),
        }),
        error: SessionRefusal,
    },
    // Needs a factor proven in the last few minutes. At the device limit the new PC replaces the
    // old one when the self-service window allows; FORBIDDEN when it no longer does, or the key
    // was enrolled elsewhere since the loader asked (the loader's own request names those first).
    "devices.enrollments.approve": {
        session: "member",
        effect: "write",
        input: z.strictObject({ operationId: OperationId, enrollmentId: WireId }),
        output: z.object({ deviceId: WireId, replaced: z.boolean() }),
        error: z.discriminatedUnion("code", [
            Unavailable,
            ...SessionRefusals,
            refusal("NOT_FOUND"),
            refusal("FORBIDDEN"),
            Reused,
        ]),
    },
    "devices.enrollments.deny": {
        session: "member",
        effect: "write",
        input: z.strictObject({ enrollmentId: WireId }),
        output: Done,
        error: DeviceRefusal,
    },
    // The member's live PCs, and when they may next replace one themselves (null: now).
    "devices.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        // `limit`: how many live PCs the account holds before approving another replaces one.
        output: z.object({
            devices: z.array(Device).readonly(),
            limit: z.number().int().positive(),
            replaceableFrom: DeviceWindow,
        }),
        error: SessionRefusal,
    },
    // Null clears the name.
    "devices.rename": {
        session: "member",
        effect: "write",
        input: z.strictObject({ deviceId: WireId, name: DeviceName.nullable() }),
        output: Done,
        error: DeviceRefusal,
    },
    // Needs a factor proven in the last few minutes, like approving one. Removing is a
    // self-service change like replacing: refused while the window is closed, and it starts the
    // window, or removing and enrolling would replace a PC as often as anyone liked.
    "devices.remove": {
        session: "member",
        effect: "write",
        input: z.strictObject({ operationId: OperationId, deviceId: WireId }),
        output: Done,
        error: z.discriminatedUnion("code", [
            Unavailable,
            ...SessionRefusals,
            refusal("NOT_FOUND"),
            refusal("DEVICE_CHANGE_TOO_SOON"),
            Reused,
        ]),
    },

    // The products the member is entitled to now, in catalog order, with the channels they may run
    // and each channel's current release (null: none promoted there yet). supported: the release's
    // current fact sets cover the game's latest reported builds, by the start's own rule.
    "products.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            products: z
                .array(
                    z.object({
                        productId: ProductId,
                        name: z.string(),
                        kind: z.string(),
                        features: Features,
                        channels: z
                            .array(
                                z.object({
                                    channel: ChannelId,
                                    release: z
                                        .object({ promotedAt: EpochMs, supported: z.boolean() })
                                        .nullable(),
                                }),
                            )
                            .readonly(),
                    }),
                )
                .readonly(),
        }),
        error: SessionRefusal,
    },

    // Whether the member may download the loader now: "no_product" without an entitlement to a
    // product other than the loader, "no_release" while none is promoted. The bytes come from the
    // internal listener's download route, not through RPC.
    "download.loader": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.discriminatedUnion("state", [
            z.object({ state: z.literal("ready"), number: SealNumber }),
            z.object({ state: z.literal("no_product") }),
            z.object({ state: z.literal("no_release") }),
        ]),
        error: SessionRefusal,
    },

    "admin.accounts.list": {
        session: "member",
        effect: "read",
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
        effect: "read",
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
            // Every entitlement the account was issued, newest first, ended ones included.
            entitlements: z.array(Entitlement).readonly(),
            devices: z.array(Device).readonly(),
            limit: z.number().int().positive(),
            replaceableFrom: DeviceWindow,
        }),
        error: ReadRefusal,
    },
    // The setup link is in this reply only; a replay has none (receipts hold no secrets).
    "admin.accounts.create": {
        session: "member",
        effect: "write",
        input: z.strictObject({ operationId: OperationId, email: z.email().max(254) }),
        output: z.object({ accountId: AccountId, setupToken: BearerToken.nullable() }),
        error: z.discriminatedUnion("code", [...StaffRefusals, Reused, refusal("EMAIL_TAKEN")]),
    },
    "admin.accounts.suspend": {
        session: "member",
        effect: "write",
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
        effect: "write",
        input: z.strictObject({ operationId: OperationId, accountId: AccountId }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, Reused, refusal("NOT_FOUND")]),
    },
    "admin.accounts.rename": {
        session: "member",
        effect: "write",
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
        effect: "write",
        input: z.strictObject({ accountId: AccountId }),
        output: z.object({ setupToken: BearerToken }),
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },

    // Valid from `validFrom` until `validUntil` (null: no end), each product on the channels given.
    "admin.entitlements.issue": {
        session: "member",
        effect: "write",
        input: z.strictObject({
            operationId: OperationId,
            accountId: AccountId,
            validFrom: EpochMs,
            validUntil: EpochMs.nullable(),
            products: z
                .array(
                    z.strictObject({
                        productId: ProductId,
                        features: z.union([z.literal("*"), z.array(FeatureTag).min(1).max(64)]),
                        channels: z.array(ChannelId).min(1).max(8),
                    }),
                )
                .min(1)
                .max(16),
        }),
        output: z.object({ entitlementId: EntitlementId }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            Reused,
            refusal("NOT_FOUND"),
            refusal("UNKNOWN_PRODUCT"),
            refusal("UNKNOWN_CHANNEL"),
            refusal("INVALID_WINDOW"),
        ]),
    },

    "admin.roles.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ roles: z.array(RoleSummary).readonly() }),
        error: ReadRefusal,
    },
    "admin.roles.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({ roleId: RoleId }),
        output: RoleSummary,
        error: ReadRefusal,
    },
    // Creates or rewrites a role. Channel grants aren't edited here and stay as they are.
    "admin.roles.save": {
        session: "member",
        effect: "write",
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
        effect: "write",
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
        effect: "write",
        input: z.strictObject({ accountId: AccountId, roleId: RoleId }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },

    // Every product and channel in catalog order, with its current seal and the seals at or above
    // it, highest first.
    "admin.releases.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ lines: z.array(ReleaseLine).readonly() }),
        error: ReadRefusal,
    },
    // Makes the seal current for its product and channel. One below the current seal is refused:
    // clients refuse a number below one they've seen. The current one again changes nothing.
    "admin.releases.promote": {
        session: "member",
        effect: "write",
        input: z.strictObject({ productId: ProductId, channel: ChannelId, number: SealNumber }),
        output: z.object({ changed: z.boolean() }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            z.object({ code: z.literal("SEAL_BELOW_CURRENT"), current: SealNumber }),
        ]),
    },
    // A module release's fact sets: each build's current set, and the newest sets first.
    "admin.facts.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ releaseId: WireId }),
        output: z.object({
            releaseId: WireId,
            productId: z.string(),
            channel: z.string(),
            builds: z
                .array(
                    z.object({
                        build: ModuleBuild,
                        current: z
                            .object({
                                setId: FactSetId,
                                revision: z.number().int(),
                                promotedAt: EpochMs,
                            })
                            .nullable(),
                    }),
                )
                .readonly(),
            sets: z
                .array(
                    z.object({
                        setId: FactSetId,
                        revision: z.number().int(),
                        stagedAt: EpochMs,
                        builds: z.array(ModuleBuild).readonly(),
                    }),
                )
                .readonly(),
        }),
        error: ReadRefusal,
    },
    // Makes the set current for every build it lists. A set below the current revision of any of
    // them is refused; one current for all of them already changes nothing.
    "admin.facts.promote": {
        session: "member",
        effect: "write",
        input: z.strictObject({ releaseId: WireId, setId: FactSetId }),
        output: z.object({ changed: z.boolean() }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            z.object({ code: z.literal("REVISION_BELOW_CURRENT"), current: z.number().int() }),
        ]),
    },

    "admin.audit.list": {
        session: "member",
        effect: "read",
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
