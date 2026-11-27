import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ListingPage } from "../../features/cloud/ListingPage.tsx";
import { fetchListing } from "../../features/cloud/server.ts";
import { toNotFound } from "../../server/route-control.ts";

// One listing of a product's cloud, under the product's own head row (the picker, changes, docs,
// cloud). "cloud_" keeps it a sibling of the cloud list, not its child. A listing of another
// product, or one the member may not see, is not found.
export const Route = createFileRoute("/_member/products/$productId/cloud_/$listingId")({
    loader: async ({ params }) => {
        const listing = await fetchListing({ data: { listingId: params.listingId } });
        if (!listing.ok && listing.refused.code === "NOT_FOUND") return toNotFound();
        if (listing.ok && listing.value.productId !== params.productId) return toNotFound();
        return listing;
    },
    head: ({ loaderData }) => ({
        meta: [
            {
                title: SITE_COPY.pageTitle(
                    loaderData?.ok === true ? loaderData.value.name : SITE_COPY.name,
                ),
            },
        ],
    }),
    component: ListingPage,
});
