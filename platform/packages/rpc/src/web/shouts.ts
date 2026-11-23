import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Author, ContentId, PostRefusal, ViewRefusal } from "./community.ts";

export const ShoutBody = z.string().trim().min(1).max(280);

export const shoutsContract = defineContract({
    // productId null: the whole feed, entries about products the reader may see included.
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
});
