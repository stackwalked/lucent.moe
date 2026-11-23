import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { OverrideReleasesPage } from "../../features/admin/overrides/OverrideReleasesPage.tsx";
import { listReleases } from "../../features/admin/releases/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/overrides/")({
    beforeLoad: ({ context }) => guardSection(context.session, "overrides"),
    loader: () => listReleases(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.overrides) }] }),
    component: OverrideReleasesPage,
});
