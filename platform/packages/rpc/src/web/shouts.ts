import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Author, ContentId, PostRefusal, ViewRefusal } from "./community.ts";
import { Done, refusal, StaffRefusals, Unavailable } from "./shared.ts";

export const ShoutBody = z.string().trim().min(1).max(280);

// Deleting is not posting, so it is never restricted. Someone who is neither the author nor
// staff with `moderation:remove` is told what a missing shout is told.
export const ShoutDeleteRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
    z.object({ code: z.literal("STEP_UP_REQUIRED"), withinSeconds: z.number() }),
]);

export const shoutsContract = defineContract({
    // productId null: the whole feed, entries about products the reader may see included.
    // `canDelete`: the reader wrote it, or holds `moderation:remove`.
    "shouts.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ productId: ProductId.nullable(), cursor: ContentId.nullable() }),
        output: z.object({
            items: z
                .array(
                    z.object({
                        id: ContentId,
                        author: Author,
                        productId: ProductId.nullable(),
                        body: z.string(),
                        createdAt: EpochMs,
                        isMine: z.boolean(),
                        canDelete: z.boolean(),
                    }),
                )
                .readonly(),
            nextCursor: ContentId.nullable(),
        }),
        error: ViewRefusal,
    },
    "shouts.create": {
        session: "member",
        effect: "write",
        input: z.strictObject({ productId: ProductId.nullable(), body: ShoutBody }),
        output: z.object({ id: ContentId }),
        error: PostRefusal,
    },
    // The author removes their own at any age; staff with `moderation:remove` remove anyone's
    // (audited as shout.remove). Removing one that is already removed changes nothing.
    "shouts.delete": {
        session: "member",
        effect: "write",
        input: z.strictObject({ id: ContentId }),
        output: Done,
        error: ShoutDeleteRefusal,
    },
    // Either every not-yet-removed shout of one account, or the newest N in the whole feed
    // (1 to 100); one audit entry (shout.purge) carries the count.
    "admin.shouts.purge": {
        session: "member",
        effect: "write",
        input: z.union([
            z.strictObject({ username: z.string().min(1).max(64) }),
            z.strictObject({ last: z.number().int().min(1).max(100) }),
        ]),
        output: z.object({ removed: z.number().int().nonnegative() }),
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },
});
