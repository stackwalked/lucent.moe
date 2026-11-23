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
} from "@lucent/core/scalars";
import { ActionSchema } from "@lucent/policy/actions";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import {
    AuditEntry,
    Cursor,
    Device,
    DeviceWindow,
    Done,
    Features,
    pageOf,
    ReadRefusal,
    Reused,
    refusal,
    StaffRefusals,
    Username,
} from "./shared.ts";

// "setup_pending": no way to sign in yet (no passkey, and not both a password and confirmed
// TOTP), whether new or recovered.
export const AccountStatus = z.enum(["active", "suspended", "locked", "setup_pending"]);

export type AccountStatus = z.output<typeof AccountStatus>;

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

const RoleSummary = z.object({
    roleId: RoleId,
    name: z.string(),
    rank: z.number().int(),
    permissions: z.array(z.string()).readonly(),
    unknownPermissions: z.array(z.string()).readonly(),
    holders: z.number().int(),
});

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

export const authorityContract = defineContract({
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
            refusal("PRODUCT_NOT_ISSUABLE"),
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
});
