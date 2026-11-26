import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { InviteTreePage } from "../../features/admin/invites/InviteTreePage.tsx";
import { fetchInviteTree } from "../../features/admin/invites/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/members/invites")({
    beforeLoad: ({ context }) => guardSection(context.session, "invites"),
    loader: () => fetchInviteTree(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.invites) }] }),
    component: InviteTreePage,
});
