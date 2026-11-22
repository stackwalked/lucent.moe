import { ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Features, SessionRefusal } from "./shared.ts";

export const productsContract = defineContract({
    // The products the member is entitled to now, in catalog order, with the channels they may run
    // and each channel's current release (null: none promoted there yet). supported: the release's
    // current fact sets cover the game's latest reported builds, by the start's own rule.
    "products.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            products: z
                .array(
                    z.object({
                        productId: ProductId,
                        name: z.string(),
                        kind: z.string(),
                        features: Features,
                        channels: z
                            .array(
                                z.object({
                                    channel: ChannelId,
                                    release: z
                                        .object({ promotedAt: EpochMs, supported: z.boolean() })
                                        .nullable(),
                                }),
                            )
                            .readonly(),
                    }),
                )
                .readonly(),
        }),
        error: SessionRefusal,
    },
});
