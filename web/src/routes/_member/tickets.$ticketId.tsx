import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { TICKETS_TITLE } from "../../features/tickets/copy.ts";
import { fetchTicket } from "../../features/tickets/server.ts";
import { TicketPage } from "../../features/tickets/TicketPage.tsx";
import { isUuid } from "../../formats.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_member/tickets/$ticketId")({
    loader: ({ params }) =>
        isUuid(params.ticketId)
            ? fetchTicket({ data: { ticketId: params.ticketId } })
            : toNotFound(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(TICKETS_TITLE) }] }),
    component: TicketPage,
});
