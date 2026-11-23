import type { ProductCatalog } from "@lucent/catalog/catalog";
import { decideProductLifecycle } from "@lucent/catalog/lifecycle.rules";
import { err, ok, type Result } from "@lucent/core/result";
import type { ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";

export type IssueRefusal =
    | { readonly code: "NO_PRODUCTS" }
    | { readonly code: "INVALID_WINDOW" }
    | { readonly code: "PRODUCT_NOT_ISSUABLE" }
    | { readonly code: "UNKNOWN_PRODUCT"; readonly productId: ProductId }
    | {
          readonly code: "UNKNOWN_CHANNEL";
          readonly productId: ProductId;
          readonly channel: ChannelId;
      };

export function decideIssueEntitlement(params: {
    readonly catalog: ProductCatalog;
    readonly validFrom: EpochMs;
    readonly validUntil: EpochMs | null;
    readonly products: readonly {
        readonly productId: ProductId;
        readonly channels: readonly ChannelId[];
    }[];
}): Result<void, IssueRefusal> {
    if (params.products.length === 0) return err({ code: "NO_PRODUCTS" });
    if (params.validUntil !== null && params.validUntil <= params.validFrom)
        return err({ code: "INVALID_WINDOW" });
    for (const { productId, channels } of params.products) {
        const product = params.catalog.get(productId);
        if (product === undefined) return err({ code: "UNKNOWN_PRODUCT", productId });
        if (!decideProductLifecycle(product.state).value.issuable)
            return err({ code: "PRODUCT_NOT_ISSUABLE" });
        for (const channel of channels) {
            if (!product.channels.includes(channel))
                return err({ code: "UNKNOWN_CHANNEL", productId, channel });
        }
    }
    return ok(undefined);
}
