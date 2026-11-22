import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { ReleasesPage } from "../../features/admin/releases/ReleasesPage.tsx";
import { listReleases } from "../../features/admin/releases/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/releases/")({
    beforeLoad: ({ context }) => guardSection(context.session, "releases"),
    loader: () => listReleases(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.releases) }] }),
    component: ReleasesPage,
});
