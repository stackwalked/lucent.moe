import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { STAFF_RESOURCES_TITLE } from "../../features/admin/resources/copy.ts";
import { StaffResourcesPage } from "../../features/admin/resources/StaffResourcesPage.tsx";
import { listStaffResources } from "../../features/admin/resources/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/resources")({
    beforeLoad: ({ context }) => guardSection(context.session, "resources"),
    loader: () => listStaffResources(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(STAFF_RESOURCES_TITLE) }] }),
    component: StaffResourcesPage,
});
