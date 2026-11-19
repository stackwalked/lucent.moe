import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { PRODUCTS_COPY } from "../../features/products/copy.ts";
import { ProductPage } from "../../features/products/ProductPage.tsx";
import { fetchProducts } from "../../features/products/server.ts";
import { isGameProduct, productName } from "../../features/products/view.ts";
import { toNotFound, toUnavailable } from "../../server/route-control.ts";

// A product the member isn't entitled to is as absent as one that doesn't exist.
export const Route = createFileRoute("/_member/products/$productId")({
    loader: async ({ params }) => {
        const products = await fetchProducts();
        if (!products.ok) return toUnavailable(products.refused.reference ?? "");
        const product = products.value.find(
            (p) => p.productId === params.productId && isGameProduct(p),
        );
        return product ?? toNotFound();
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
