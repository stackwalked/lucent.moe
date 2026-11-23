import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Author, ContentId, PostRefusal, ViewRefusal } from "./community.ts";
import { Done } from "./shared.ts";

export const GuideTitle = z.string().trim().min(1).max(120);
export const GuideBody = z.string().trim().min(1).max(20_000);

const summary = {
    id: ContentId,
    title: z.string(),
    author: Author,
    createdAt: EpochMs,
    updatedAt: EpochMs,
};

export const guidesContract = defineContract({
    "guides.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ productId: ProductId, cursor: ContentId.nullable() }),
        output: z.object({
            items: z.array(z.object(summary)).readonly(),
            nextCursor: ContentId.nullable(),
        }),
        error: ViewRefusal,
    },
    "guides.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({ id: ContentId }),
        output: z.object({
            ...summary,
            productId: ProductId,
            body: z.string(),
            isMine: z.boolean(),
        }),
        error: ViewRefusal,
    },
    "guides.create": {
        session: "member",
        effect: "write",
        input: z.strictObject({ productId: ProductId, title: GuideTitle, body: GuideBody }),
        output: z.object({ id: ContentId }),
        error: PostRefusal,
    },
    "guides.update": {
        session: "member",
        effect: "write",
        input: z.strictObject({ id: ContentId, title: GuideTitle, body: GuideBody }),
        output: Done,
        error: PostRefusal,
    },
});
