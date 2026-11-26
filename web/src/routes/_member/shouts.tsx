import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { ShoutsPage } from "../../features/shouts/ShoutsPage.tsx";
import { shoutsSearch } from "../../features/shouts/search.ts";
import { fetchShouts } from "../../features/shouts/server.ts";
import { SHOUTS_TITLE } from "../../features/shouts/title.ts";

export const Route = createFileRoute("/_member/shouts")({
    validateSearch: shoutsSearch,
    loaderDeps: ({ search }) => ({ product: search.product ?? null }),
    loader: async ({ deps }) => {
        const [shouts, products] = await Promise.all([
            fetchShouts({ data: { productId: deps.product, cursor: null } }),
            fetchProducts(),
        ]);
        return { shouts, products };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(SHOUTS_TITLE) }] }),
    component: ShoutsPage,
});
