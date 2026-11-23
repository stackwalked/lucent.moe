import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Author, ContentId } from "./community.ts";
import { MemberRefusal } from "./inbox.ts";

export const SearchText = z.string().trim().min(1).max(64);

export const searchContract = defineContract({
    // Guides by their words (most relevant first) and accounts by the start of a username. Only
    // what the member may see: listed products, no removed guides, nothing a block hides, no
    // private profiles.
    "search.results.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ q: SearchText }),
        output: z.object({
            guides: z
                .array(
                    z.object({
                        id: ContentId,
                        productId: ProductId,
                        title: z.string(),
                        author: Author,
                        updatedAt: EpochMs,
                    }),
                )
                .readonly(),
            accounts: z.array(z.object({ username: z.string() })).readonly(),
        }),
        error: MemberRefusal,
    },
});
