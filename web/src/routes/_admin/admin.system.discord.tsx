import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { DiscordRulesPage } from "../../features/admin/discord/DiscordRulesPage.tsx";
import { listDiscordRules } from "../../features/admin/discord/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/system/discord")({
    beforeLoad: ({ context }) => guardSection(context.session, "discord"),
    loader: () => listDiscordRules(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.discord) }] }),
    component: DiscordRulesPage,
});
