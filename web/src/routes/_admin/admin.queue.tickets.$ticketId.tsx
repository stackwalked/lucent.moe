import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fromSearch } from "../../features/admin/queue/from.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { STAFF_TICKETS_TITLE } from "../../features/admin/tickets/copy.ts";
import { StaffTicketPage } from "../../features/admin/tickets/StaffTicketPage.tsx";
import { fetchStaffTicket } from "../../features/admin/tickets/server.ts";
import { fetchPublicProducts } from "../../features/products/server.ts";
import { isUuid } from "../../formats.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_admin/admin/queue/tickets/$ticketId")({
    validateSearch: fromSearch,
    beforeLoad: ({ context }) => guardSection(context.session, "tickets"),
    loader: async ({ params }) => {
        if (!isUuid(params.ticketId)) return toNotFound();
        const [ticket, catalog] = await Promise.all([
            fetchStaffTicket({ data: { ticketId: params.ticketId } }),
            fetchPublicProducts(),
        ]);
        return { ticket, catalog };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(STAFF_TICKETS_TITLE) }] }),
    component: StaffTicketPage,
});
