import { ProductState } from "@lucent/catalog/product";
import { ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Features, SessionRefusal } from "./shared.ts";

export const productsContract = defineContract({
    // The products visible to the member, in catalog order, with the channels they may run
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
                        state: ProductState,
                        // The member's entitlement to it, when one is active now: validUntil
                        // null when it does not end. Null access: none held.
                        access: z.object({ validUntil: EpochMs.nullable() }).nullable(),
                        features: Features,
                        channels: z
                            .array(
                                z.object({
                                    channel: ChannelId,
                                    release: z
                                        .object({
                                            promotedAt: EpochMs,
                                            supported: z.boolean(),
                                            // The version of the entry that names this release.
                                            version: z.string().nullable(),
                                        })
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
