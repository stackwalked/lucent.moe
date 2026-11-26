import { isProductId, type ProductId } from "@lucent/core/brands";
import { searchSchema } from "../../search.ts";

// ?product=: a product that is not an id is ignored, as if it were not there.
export const shoutsSearch = searchSchema<
    { readonly product?: ProductId },
    { readonly product?: string }
>((search) => {
    const product = search["product"];
    return isProductId(product) ? { product } : {};
});
