import { createFileRoute } from "@tanstack/react-router";
import { fetchChangelog } from "../../features/changes/server.ts";
import { fetchListings } from "../../features/cloud/server.ts";
import { ProductPage } from "../../features/products/ProductPage.tsx";
import { fetchLoaderOffer } from "../../features/products/server.ts";

// The first page of the product's entries, the loader offer, and what is new in its cloud.
export const Route = createFileRoute("/_member/products/$productId/")({
    loader: async ({ params, parentMatchPromise }) => {
        const { product } = (await parentMatchPromise).loaderData ?? {};
        const [changes, loader, cloud] = await Promise.all([
            fetchChangelog({ data: { productId: params.productId } }),
            fetchLoaderOffer(),
            product === undefined || product.access === null
                ? null
                : fetchListings({ data: { productId: params.productId } }),
        ]);
        return { changes, loader, cloud };
    },
    component: ProductPage,
});
