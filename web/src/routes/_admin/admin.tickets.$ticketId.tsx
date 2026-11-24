import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { STAFF_TICKETS_TITLE } from "../../features/admin/tickets/copy.ts";
import { StaffTicketPage } from "../../features/admin/tickets/StaffTicketPage.tsx";
import { fetchStaffTicket } from "../../features/admin/tickets/server.ts";
import { isUuid } from "../../formats.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_admin/admin/tickets/$ticketId")({
    beforeLoad: ({ context }) => guardSection(context.session, "tickets"),
    loader: ({ params }) =>
        isUuid(params.ticketId)
            ? fetchStaffTicket({ data: { ticketId: params.ticketId } })
            : toNotFound(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(STAFF_TICKETS_TITLE) }] }),
    component: StaffTicketPage,
});
