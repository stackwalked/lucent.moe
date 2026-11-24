import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { cursorDeps, cursorSearch } from "../../features/comments/cursor.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { TICKETS_TITLE } from "../../features/tickets/copy.ts";
import { fetchTickets } from "../../features/tickets/server.ts";
import { TicketsPage } from "../../features/tickets/TicketsPage.tsx";

export const Route = createFileRoute("/_member/tickets/")({
    validateSearch: cursorSearch,
    loaderDeps: cursorDeps,
    loader: async ({ deps }) => {
        const [tickets, products] = await Promise.all([
            fetchTickets({ data: { cursor: deps.cursor } }),
            fetchProducts(),
        ]);
        return { tickets, products };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(TICKETS_TITLE) }] }),
    component: TicketsPage,
});
