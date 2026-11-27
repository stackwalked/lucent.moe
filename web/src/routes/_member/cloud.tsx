import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { CLOUD_COPY } from "../../features/cloud/copy.ts";
import { lastProduct } from "../../features/products/lastProduct.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { LOADER_PRODUCT_ID } from "../../features/products/view.ts";
import { toPage, toUnavailable } from "../../server/route-control.ts";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";

// Cloud is a tab of each product: /cloud sends you to the cloud of the product you last looked
// at, else the first you hold, else the first listed.
export const Route = createFileRoute("/_member/cloud")({
    loader: async () => {
        const products = await fetchProducts();
        if (!products.ok) return toUnavailable(products.refused.reference ?? "");
        const listed = products.value.filter((p) => p.productId !== LOADER_PRODUCT_ID);
        const last = lastProduct();
        const pick =
            listed.find((p) => p.productId === last) ??
            listed.find((p) => p.access !== null) ??
            listed[0];
        if (pick !== undefined) toPage(`/products/${pick.productId}/cloud`);
        return { none: true as const };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(CLOUD_COPY.title) }] }),
    component: function CloudIndex() {
        return (
            <Page title={CLOUD_COPY.title} width="narrow">
                <Empty>{CLOUD_COPY.emptyProducts}</Empty>
            </Page>
        );
    },
});
