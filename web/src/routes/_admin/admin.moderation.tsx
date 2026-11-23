import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { listState } from "../../features/admin/list.ts";
import { MODERATION_COPY } from "../../features/admin/moderation/copy.ts";
import { ModerationPage } from "../../features/admin/moderation/ModerationPage.tsx";
import { listRestrictions } from "../../features/admin/moderation/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/moderation")({
    beforeLoad: ({ context }) => guardSection(context.session, "moderation"),
    loader: async ({ location }) => ({
        restrictions: await listRestrictions({ data: { cursor: listState(location).cursor } }),
    }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(MODERATION_COPY.title) }] }),
    component: ModerationPage,
});
