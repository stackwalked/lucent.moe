import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ApplicationPage } from "../../features/admin/applications/ApplicationPage.tsx";
import { fetchApplication } from "../../features/admin/applications/server.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_admin/admin/queue/applications/$applicationId")({
    beforeLoad: ({ context }) => guardSection(context.session, "applications"),
    loader: ({ params }) =>
        /^[1-9][0-9]{0,18}$/.test(params.applicationId)
            ? fetchApplication({ data: { applicationId: params.applicationId } })
            : toNotFound(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.applications) }] }),
    component: ApplicationPage,
});
