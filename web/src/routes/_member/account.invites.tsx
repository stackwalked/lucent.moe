import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { INVITES_COPY } from "../../features/invites/copy.ts";
import { InvitesPage } from "../../features/invites/InvitesPage.tsx";
import { fetchInvites } from "../../features/invites/server.ts";

export const Route = createFileRoute("/_member/account/invites")({
    loader: () => fetchInvites(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(INVITES_COPY.title) }] }),
    component: InvitesPage,
});
