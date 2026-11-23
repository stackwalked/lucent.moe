import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SITE_COPY } from "../../copy/site.ts";
import { cursorSearch } from "../../features/comments/cursor.ts";
import { ShoutsPage } from "../../features/shouts/ShoutsPage.tsx";
import { fetchShouts } from "../../features/shouts/server.ts";
import { SHOUTS_TITLE } from "../../features/shouts/title.ts";

export const Route = createFileRoute("/_member/shouts")({
    validateSearch: cursorSearch.extend({ product: z.string().max(32).optional() }),
    loaderDeps: ({ search }) => ({
        cursor: search.cursor ?? null,
        product: search.product ?? null,
    }),
    loader: ({ deps }) => fetchShouts({ data: { productId: deps.product, cursor: deps.cursor } }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(SHOUTS_TITLE) }] }),
    component: ShoutsPage,
});
