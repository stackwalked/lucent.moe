import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { SUPPORT_TITLE } from "../../features/support/copy.ts";
import { SupportPage } from "../../features/support/SupportPage.tsx";
import { fetchTicket, fetchTickets } from "../../features/support/server.ts";
import { isUuid } from "../../formats.ts";
import { toNotFound } from "../../server/route-control.ts";

// /support/<id> shows that ticket, whatever its state. Someone else's or a missing one is not
// found, as anywhere.
export const Route = createFileRoute("/_member/support/$ticketId")({
    loader: async ({ params }) => {
        if (!isUuid(params.ticketId)) return toNotFound();
        const [tickets, products, shown] = await Promise.all([
            fetchTickets({ data: { cursor: null } }),
            fetchProducts(),
            fetchTicket({ data: { ticketId: params.ticketId } }),
        ]);
        if (!shown.ok && shown.refused.code === "NOT_FOUND") return toNotFound();
        return { tickets, products, shown };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(SUPPORT_TITLE) }] }),
    component: function SupportTicket() {
        return <SupportPage data={Route.useLoaderData()} />;
    },
});
