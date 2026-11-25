import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { DISCORD_TITLE } from "../../features/discord/copy.ts";
import { DiscordPage } from "../../features/discord/DiscordPage.tsx";
import { fetchDiscordLink } from "../../features/discord/server.ts";

export const Route = createFileRoute("/_member/account/discord")({
    loader: () => fetchDiscordLink(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(DISCORD_TITLE) }] }),
    component: DiscordPage,
});
