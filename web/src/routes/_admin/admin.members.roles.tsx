import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ROLES_COPY } from "../../features/admin/roles/copy.ts";
import { RolesPage } from "../../features/admin/roles/RolesPage.tsx";
import { listRoles } from "../../features/admin/roles/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/members/roles")({
    beforeLoad: ({ context }) => guardSection(context.session, "roles"),
    loader: () => listRoles(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ROLES_COPY.title) }] }),
    component: RolesPage,
});
