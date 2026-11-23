import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { listState } from "../../features/admin/list.ts";
import { ModerationPage } from "../../features/admin/moderation/ModerationPage.tsx";
import { listRestrictions } from "../../features/admin/moderation/server.ts";
import { MODERATION_TITLE } from "../../features/admin/moderation/title.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/moderation")({
    beforeLoad: ({ context }) => guardSection(context.session, "moderation"),
    loader: async ({ location }) => ({
        restrictions: await listRestrictions({ data: { cursor: listState(location).cursor } }),
    }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(MODERATION_TITLE) }] }),
    component: ModerationPage,
});
