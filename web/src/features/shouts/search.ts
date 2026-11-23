import { isProductId, type ProductId } from "@lucent/core/brands";
import { isUuid } from "../../formats.ts";
import { optional, searchSchema } from "../../search.ts";

// ?cursor= and ?product=: a product that is not an id is ignored, as if it were not there.
export const shoutsSearch = searchSchema<
    { readonly cursor?: string; readonly product?: ProductId },
    { readonly cursor?: string; readonly product?: string }
>((search) => {
    const cursor = optional(search, "cursor", isUuid);
    if (cursor === null) return null;
    const product = search["product"];
    return isProductId(product) ? { ...cursor, product } : cursor;
});
