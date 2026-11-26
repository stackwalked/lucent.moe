import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ApplicationsPage } from "../../features/admin/applications/ApplicationsPage.tsx";
import { listApplications } from "../../features/admin/applications/server.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/queue/applications/")({
    beforeLoad: ({ context }) => guardSection(context.session, "applications"),
    loader: () => listApplications(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.applications) }] }),
    component: ApplicationsPage,
});
