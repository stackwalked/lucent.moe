import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchChangelog, fetchRecordStatus } from "../../features/changes/server.ts";
import { PRODUCTS_COPY } from "../../features/products/copy.ts";
import { ProductPage } from "../../features/products/ProductPage.tsx";
import { fetchLoaderOffer, fetchProducts } from "../../features/products/server.ts";
import { LOADER_PRODUCT_ID, productName } from "../../features/products/view.ts";
import { toNotFound, toUnavailable } from "../../server/route-control.ts";

// An unlisted product is indistinguishable from one that doesn't exist. Everything the page
// shows comes scoped to the member: their products with access, the record's status and issues,
// the first page of the product's entries, and the loader offer.
export const Route = createFileRoute("/_member/products/$productId")({
    loader: async ({ params }) => {
        const products = await fetchProducts();
        if (!products.ok) return toUnavailable(products.refused.reference ?? "");
        const product = products.value.find(
            (p) => p.productId === params.productId && p.productId !== LOADER_PRODUCT_ID,
        );
        if (product === undefined) return toNotFound();
        const [status, changes, loader] = await Promise.all([
            fetchRecordStatus(),
            fetchChangelog({ data: { productId: product.productId } }),
            fetchLoaderOffer(),
        ]);
        if (!status.ok) return toUnavailable(status.refused.reference ?? "");
        return {
            product,
            access: product.access,
            held: products.value.filter((p) => p.access !== null).map((p) => p.productId),
            status: {
                products: status.value.products,
                current:
                    status.value.products.find((p) => p.productId === product.productId) ?? null,
            },
            issues: status.value.issues.filter(
                (issue) => issue.productId === null || issue.productId === product.productId,
            ),
            changes,
            loader,
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
    component: ProductPage,
});
