import { AccountId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { ReportRefusal, RestrictionKind } from "./community.ts";
import { Done, refusal, StaffRefusals } from "./shared.ts";

export const QueueId = z.uuid();

// What a member can flag: anything a member wrote that has a page of its own to be seen on.
export const ReportKind = z.enum(["comment", "shout", "guide", "profile", "listing"]);
export const ReportReason = z.enum(["spam", "abuse", "other"]);

export const moderationContract = defineContract({
    "moderation.reports.create": {
        session: "member",
        effect: "write",
        input: z.strictObject({
            kind: ReportKind,
            targetId: QueueId,
            reason: ReportReason,
            note: z.string().trim().max(500),
        }),
        output: Done,
        error: ReportRefusal,
    },
    "admin.moderation.reports.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ cursor: QueueId.nullable() }),
        output: z.object({
            items: z
                .array(
                    z.object({
                        id: QueueId,
                        kind: ReportKind,
                        targetId: QueueId,
                        reason: ReportReason,
                        note: z.string(),
                        reporter: z.object({ username: z.string().nullable() }),
                        author: z.object({ accountId: AccountId, username: z.string().nullable() }),
                        productId: ProductId.nullable(),
                        excerpt: z.string(),
                        createdAt: EpochMs,
                    }),
                )
                .readonly(),
            nextCursor: QueueId.nullable(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    // Removal hides the content from everyone and closes every open report on it; dismissal
    // closes this report only.
    "admin.moderation.reports.resolve": {
        session: "member",
        effect: "write",
        input: z.strictObject({ id: QueueId, outcome: z.enum(["remove", "dismiss"]) }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },
    "admin.moderation.restrictions.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ cursor: QueueId.nullable() }),
        output: z.object({
            items: z
                .array(
                    z.object({
                        id: QueueId,
                        accountId: AccountId,
                        username: z.string().nullable(),
                        kind: RestrictionKind,
                        productId: ProductId.nullable(),
                        reason: z.string(),
                        createdAt: EpochMs,
                        endsAt: EpochMs.nullable(),
                    }),
                )
                .readonly(),
            nextCursor: QueueId.nullable(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    "admin.moderation.restrictions.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({
            username: z.string().trim().min(1).max(64),
            kind: RestrictionKind,
            productId: ProductId.nullable(),
            reason: z.string().trim().min(1).max(500),
            endsAt: EpochMs.nullable(),
        }),
        output: z.object({ id: QueueId }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("UNKNOWN_PRODUCT"),
            refusal("INVALID_WINDOW"),
        ]),
    },
    "admin.moderation.restrictions.lift": {
        session: "member",
        effect: "write",
        input: z.strictObject({ id: QueueId }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },
});
