import { AccountId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Avatar, RestrictionKind, ViewRefusal } from "./community.ts";
import { MemberRefusal } from "./inbox.ts";
import { Done } from "./shared.ts";

export const ProfileVisibility = z.enum(["members", "private"]);

const Removed = EpochMs.nullable();

// The account's own data as one JSON file: what they wrote (removed things included, marked),
// who they blocked, what they reported, the restrictions they were under (without staff's reason)
// and their notification state. Nothing that belongs to another account, and none of the
// licence, device or credential records, which other areas hold.
export const ExportData = z.object({
    exportedAt: EpochMs,
    account: z.object({
        id: AccountId,
        email: z.string(),
        username: z.string().nullable(),
        createdAt: EpochMs,
    }),
    // Each list holds the newest 1,000 rows at most; a kind that was cut is named here.
    truncated: z.array(z.string()).readonly(),
    // `avatar` names the stored images by digest; the bytes are not in the file.
    profile: z
        .object({
            bio: z.string(),
            visibility: ProfileVisibility,
            removedAt: Removed,
            avatar: Avatar.nullable(),
        })
        .nullable(),
    guides: z
        .array(
            z.object({
                id: z.uuid(),
                productId: ProductId,
                title: z.string(),
                body: z.string(),
                createdAt: EpochMs,
                updatedAt: EpochMs,
                removedAt: Removed,
            }),
        )
        .readonly(),
    comments: z
        .array(
            z.object({
                id: z.uuid(),
                // Null for a comment on a profile wall, which names the profile instead.
                guideId: z.uuid().nullable(),
                profileUsername: z.string().nullable(),
                body: z.string(),
                createdAt: EpochMs,
                removedAt: Removed,
            }),
        )
        .readonly(),
    shouts: z
        .array(
            z.object({
                id: z.uuid(),
                productId: ProductId.nullable(),
                body: z.string(),
                createdAt: EpochMs,
                removedAt: Removed,
            }),
        )
        .readonly(),
    blocks: z.array(z.object({ username: z.string().nullable(), createdAt: EpochMs })).readonly(),
    reportsMade: z
        .array(
            z.object({
                kind: z.enum(["comment", "shout", "guide", "profile"]),
                targetId: z.uuid(),
                reason: z.enum(["spam", "abuse", "other"]),
                note: z.string(),
                state: z.enum(["open", "removed", "dismissed"]),
                createdAt: EpochMs,
            }),
        )
        .readonly(),
    restrictions: z
        .array(
            z.object({
                kind: RestrictionKind,
                productId: ProductId.nullable(),
                createdAt: EpochMs,
                endsAt: EpochMs.nullable(),
                liftedAt: EpochMs.nullable(),
            }),
        )
        .readonly(),
    inbox: z
        .array(
            z.object({
                kind: z.enum(["security", "product_status", "ticket_reply"]),
                productId: ProductId.nullable(),
                createdAt: EpochMs,
                isRead: z.boolean(),
            }),
        )
        .readonly(),
    notificationPreferences: z
        .array(z.object({ kind: z.string(), inbox: z.boolean(), mail: z.boolean() }))
        .readonly(),
    subscriptions: z.array(ProductId).readonly(),
});

export const privacyContract = defineContract({
    "privacy.blocks.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            blocks: z
                .array(z.object({ username: z.string().nullable(), createdAt: EpochMs }))
                .readonly(),
        }),
        error: ViewRefusal,
    },
    "privacy.blocks.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({ username: z.string().max(64), blocked: z.boolean() }),
        output: Done,
        error: ViewRefusal,
    },
    "privacy.shows.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            invitedBy: z.boolean(),
            invited: z.boolean(),
            products: z.boolean(),
            lastSeen: z.boolean(),
            discord: z.boolean(),
            wall: z.boolean(),
        }),
        error: MemberRefusal,
    },
    // Each key present is set; absent keys stay as they are.
    "privacy.shows.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({
            invitedBy: z.boolean().optional(),
            invited: z.boolean().optional(),
            products: z.boolean().optional(),
            lastSeen: z.boolean().optional(),
            discord: z.boolean().optional(),
            wall: z.boolean().optional(),
        }),
        output: Done,
        error: MemberRefusal,
    },
    "privacy.visibility.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({ visibility: ProfileVisibility }),
        output: Done,
        error: MemberRefusal,
    },
    "privacy.export.read": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: ExportData,
        error: MemberRefusal,
    },
    "privacy.restrictions.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            restrictions: z
                .array(
                    z.object({
                        id: z.uuid(),
                        kind: RestrictionKind,
                        productId: ProductId.nullable(),
                        endsAt: EpochMs.nullable(),
                    }),
                )
                .readonly(),
        }),
        error: MemberRefusal,
    },
});
