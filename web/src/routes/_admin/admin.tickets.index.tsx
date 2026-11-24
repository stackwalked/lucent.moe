import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { listState } from "../../features/admin/list.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { STAFF_TICKETS_TITLE } from "../../features/admin/tickets/copy.ts";
import { StaffTicketsPage } from "../../features/admin/tickets/StaffTicketsPage.tsx";
import { ticketsSearch } from "../../features/admin/tickets/search.ts";
import { listTickets } from "../../features/admin/tickets/server.ts";

export const Route = createFileRoute("/_admin/admin/tickets/")({
    beforeLoad: ({ context }) => guardSection(context.session, "tickets"),
    validateSearch: ticketsSearch,
    loaderDeps: ({ search }) => ({ view: search.state ?? "open" }),
    loader: async ({ deps, location }) => ({
        view: deps.view,
        outcome: await listTickets({
            data: { state: deps.view, cursor: listState(location).cursor },
        }),
    }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(STAFF_TICKETS_TITLE) }] }),
    component: StaffTicketsPage,
});
