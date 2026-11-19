import { ChannelId, ProductId } from "@lucent/core/scalars";
import { z } from "zod";

// A product as the rest of lucent sees it. Apart from catalog.ts, which reads products/*.toml
// from disk, so the web contract can carry the shape without filesystem code.
export const ProductDefinition = z
    .strictObject({
        id: ProductId,
        name: z.string().min(1).max(64),
        kind: z.enum(["module", "standalone"]),
        channels: z.array(ChannelId).min(1).max(16).readonly(),
        concurrentSlots: z.number().int().min(1).max(16),
    })
    .readonly();
export type ProductDefinition = z.output<typeof ProductDefinition>;
