import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { PRODUCTS_COPY } from "../../features/products/copy.ts";
import { lastProduct } from "../../features/products/lastProduct.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { LOADER_PRODUCT_ID } from "../../features/products/view.ts";
import { toPage, toUnavailable } from "../../server/route-control.ts";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";

// No index of products: /products sends you to the one you last looked at, else the first you
// hold, else the first listed. With nothing listed at all there is nowhere to go, and the page
// says so.
export const Route = createFileRoute("/_member/products/")({
    loader: async () => {
        const products = await fetchProducts();
        if (!products.ok) return toUnavailable(products.refused.reference ?? "");
        const listed = products.value.filter((p) => p.productId !== LOADER_PRODUCT_ID);
        if (listed.length === 0) return { none: true as const };
        const last = lastProduct();
        const remembered =
            last === undefined ? undefined : listed.find((p) => p.productId === last);
        const held = listed.find((p) => p.access !== null);
        const pick = remembered ?? held ?? listed[0];
        if (pick !== undefined) toPage(`/products/${pick.productId}`);
        return { none: true as const };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PRODUCTS_COPY.title) }] }),
    component: function ProductsIndex() {
        return (
            <Page title={PRODUCTS_COPY.title} width="narrow">
                <Empty>{PRODUCTS_COPY.none}</Empty>
            </Page>
        );
    },
});
