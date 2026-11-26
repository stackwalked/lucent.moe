import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { AdminCloudPage } from "../../features/admin/cloud/AdminCloudPage.tsx";
import { listPendingListings } from "../../features/admin/cloud/server.ts";
import { ADMIN_CLOUD_TITLE } from "../../features/admin/cloud/title.ts";
import { listState } from "../../features/admin/list.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/cloud")({
    beforeLoad: ({ context }) => guardSection(context.session, "cloud"),
    loader: ({ location }) => listPendingListings({ data: { cursor: listState(location).cursor } }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_CLOUD_TITLE) }] }),
    component: AdminCloudPage,
});
