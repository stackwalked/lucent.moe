import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { cursorDeps, cursorSearch } from "../../features/comments/cursor.ts";
import { fetchGuides } from "../../features/guides/server.ts";
import { PRODUCTS_COPY } from "../../features/products/copy.ts";
import { ProductPage } from "../../features/products/ProductPage.tsx";
import { fetchProducts } from "../../features/products/server.ts";
import { productName } from "../../features/products/view.ts";
import { toNotFound, toUnavailable } from "../../server/route-control.ts";

// An unlisted product is indistinguishable from one that doesn't exist. Its guides come with it,
// a page at a time.
export const Route = createFileRoute("/_member/products/$productId")({
    validateSearch: cursorSearch,
    loaderDeps: cursorDeps,
    loader: async ({ params, deps }) => {
        const products = await fetchProducts();
        if (!products.ok) return toUnavailable(products.refused.reference ?? "");
        const product = products.value.find((p) => p.productId === params.productId);
        if (product === undefined) return toNotFound();
        const guides = await fetchGuides({
            data: { productId: product.productId, cursor: deps.cursor },
        });
        return { ...product, guides };
    },
    head: ({ loaderData }) => ({
        meta: [
            {
                title: SITE_COPY.pageTitle(
                    loaderData === undefined ? PRODUCTS_COPY.title : productName(loaderData.name),
                ),
            },
        ],
    }),
    component: ProductPage,
});
