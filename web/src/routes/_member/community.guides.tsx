import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { COMMUNITY_COPY } from "../../features/community/copy.ts";
import { GuidesPage } from "../../features/community/GuidesPage.tsx";
import { fetchGuides } from "../../features/guides/server.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { LOADER_PRODUCT_ID } from "../../features/products/view.ts";
import { toUnavailable } from "../../server/route-control.ts";

// Guides are a product's: every product the member may see gets its first page here.
export const Route = createFileRoute("/_member/community/guides")({
    loader: async () => {
        const listed = await fetchProducts();
        if (!listed.ok) return toUnavailable(listed.refused.reference ?? "");
        const shown = listed.value.filter((product) => product.productId !== LOADER_PRODUCT_ID);
        const products = await Promise.all(
            shown.map(async (product) => ({
                productId: product.productId,
                name: product.name,
                guides: await fetchGuides({ data: { productId: product.productId, cursor: null } }),
            })),
        );
        return { products };
    },
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(`${COMMUNITY_COPY.guides} · ${COMMUNITY_COPY.title}`) },
        ],
    }),
    component: function CommunityGuides() {
        return <GuidesPage data={Route.useLoaderData()} />;
    },
});
