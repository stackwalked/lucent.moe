import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { SUPPORT_TITLE } from "../../features/support/copy.ts";
import { SupportPage } from "../../features/support/SupportPage.tsx";
import { supportSearch } from "../../features/support/search.ts";
import { fetchTicket, fetchTickets } from "../../features/support/server.ts";

// /support shows the member's latest ticket that is not closed; with none, or with ?new, the
// left side is the form that opens one. The list's first page and the products come either way.
export const Route = createFileRoute("/_member/support/")({
    validateSearch: supportSearch,
    loaderDeps: ({ search }) => ({ isNew: search["new"] === "true" }),
    loader: async ({ deps }) => {
        const [tickets, products] = await Promise.all([
            fetchTickets({ data: { cursor: null } }),
            fetchProducts(),
        ]);
        let shown = null;
        if (!deps.isNew && tickets.ok) {
            const current = tickets.value.items.find((ticket) => ticket.state !== "closed");
            if (current !== undefined)
                shown = await fetchTicket({ data: { ticketId: current.id } });
        }
        return { tickets, products, shown };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(SUPPORT_TITLE) }] }),
    component: function SupportIndex() {
        return <SupportPage data={Route.useLoaderData()} />;
    },
});
