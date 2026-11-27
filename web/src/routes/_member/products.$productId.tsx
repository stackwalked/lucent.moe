import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchRecordStatus } from "../../features/changes/server.ts";
import { PRODUCTS_COPY } from "../../features/products/copy.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { LOADER_PRODUCT_ID, productName } from "../../features/products/view.ts";
import { toNotFound, toUnavailable } from "../../server/route-control.ts";

// A product's pages (changes, cloud) share their head: the picker and the tabs. An unlisted
// product is indistinguishable from one that doesn't exist. What the head needs comes scoped to
// the member: their products with access and the record's status of each.
export const Route = createFileRoute("/_member/products/$productId")({
    loader: async ({ params }) => {
        const [products, status] = await Promise.all([fetchProducts(), fetchRecordStatus()]);
        if (!products.ok) return toUnavailable(products.refused.reference ?? "");
        const product = products.value.find(
            (p) => p.productId === params.productId && p.productId !== LOADER_PRODUCT_ID,
        );
        if (product === undefined) return toNotFound();
        if (!status.ok) return toUnavailable(status.refused.reference ?? "");
        return {
            product,
            held: products.value.filter((p) => p.access !== null).map((p) => p.productId),
            status: status.value,
        };
    },
    head: ({ loaderData }) => ({
        meta: [
            {
                title: SITE_COPY.pageTitle(
                    loaderData === undefined
                        ? PRODUCTS_COPY.title
                        : productName(loaderData.product.name),
                ),
            },
        ],
    }),
    component: Outlet,
});
