import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchChangelog, fetchRecordStatus } from "../../features/changes/server.ts";
import { cursorDeps, cursorSearch } from "../../features/comments/cursor.ts";
import { fetchGuides } from "../../features/guides/server.ts";
import { PRODUCTS_COPY } from "../../features/products/copy.ts";
import { ProductPage } from "../../features/products/ProductPage.tsx";
import { fetchLoaderOffer, fetchProducts } from "../../features/products/server.ts";
import { LOADER_PRODUCT_ID, productName } from "../../features/products/view.ts";
import { toNotFound, toUnavailable } from "../../server/route-control.ts";

// An unlisted product is indistinguishable from one that doesn't exist. Everything the page
// shows comes scoped to the member: their products with access, the record's status and issues,
// the first page of the product's entries, the loader offer, and the product's guides.
export const Route = createFileRoute("/_member/products/$productId")({
    validateSearch: cursorSearch,
    loaderDeps: cursorDeps,
    loader: async ({ params, deps }) => {
        const products = await fetchProducts();
        if (!products.ok) return toUnavailable(products.refused.reference ?? "");
        const product = products.value.find(
            (p) => p.productId === params.productId && p.productId !== LOADER_PRODUCT_ID,
        );
        if (product === undefined) return toNotFound();
        const [status, changes, loader, guides] = await Promise.all([
            fetchRecordStatus(),
            fetchChangelog({ data: { productId: product.productId } }),
            fetchLoaderOffer(),
            fetchGuides({ data: { productId: product.productId, cursor: deps.cursor } }),
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
            guides,
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
