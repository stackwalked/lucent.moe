import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { SystemPage } from "../../features/admin/system/SystemPage.tsx";
import { readSystemStatus } from "../../features/admin/system/server.ts";

export const Route = createFileRoute("/_admin/admin/system")({
    beforeLoad: ({ context }) => guardSection(context.session, "system"),
    loader: () => readSystemStatus(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.system) }] }),
    component: SystemPage,
});
