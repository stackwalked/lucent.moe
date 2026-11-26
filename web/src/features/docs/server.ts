import { createServerFn } from "@tanstack/react-start";
import { readPlatform } from "../../server/platform.ts";
import { DOC_FILES } from "./files.ts";
import { scopesWithPages } from "./index.ts";

export type VisibleScope = { readonly scope: string; readonly name: string | null };

// The scopes with pages that this member may open: `lucent` for everyone, a product when it is
// one of those listed for them. With no pages on disk nothing is read.
export const fetchDocScopes = createServerFn({ method: "GET" }).handler(
    async (): Promise<readonly VisibleScope[]> => {
        const withPages = scopesWithPages(DOC_FILES);
        if (withPages.length === 0) return [];
        const reply = await readPlatform("products.list", {});
        const listed = reply.ok ? reply.value.products : [];
        const products = withPages.flatMap((scope) => {
            const product = listed.find((entry) => entry.productId === scope);
            return product === undefined ? [] : [{ scope, name: product.name }];
        });
        return [
            ...products,
            ...(withPages.includes("lucent") ? [{ scope: "lucent", name: null }] : []),
        ];
    },
);
