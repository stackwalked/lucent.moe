import { AccountId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { RestrictionKind } from "./privacy.ts";
import { Done, refusal, StaffRefusals } from "./shared.ts";

export const QueueId = z.uuid();

export const moderationContract = defineContract({
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
