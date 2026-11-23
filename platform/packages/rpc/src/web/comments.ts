import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Author, ContentId, PostRefusal, ViewRefusal } from "./community.ts";

export const CommentBody = z.string().trim().min(1).max(2_000);

export const commentsContract = defineContract({
    // A comment belongs to its guide and shows to whoever may see the guide's product.
    "comments.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ guideId: ContentId, cursor: ContentId.nullable() }),
        output: z.object({
            items: z
                .array(
                    z.object({
                        id: ContentId,
                        author: Author,
                        body: z.string(),
                        createdAt: EpochMs,
                        isMine: z.boolean(),
                    }),
                )
                .readonly(),
            nextCursor: ContentId.nullable(),
        }),
        error: ViewRefusal,
    },
    "comments.create": {
        session: "member",
        effect: "write",
        input: z.strictObject({ guideId: ContentId, body: CommentBody }),
        output: z.object({ id: ContentId }),
        error: PostRefusal,
    },
});
