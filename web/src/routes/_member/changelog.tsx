import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ChangelogPage } from "../../features/changelog/ChangelogPage.tsx";
import { CHANGELOG_COPY } from "../../features/changelog/copy.ts";
import { fetchChangelog } from "../../features/status/server.ts";

export const Route = createFileRoute("/_member/changelog")({
    loader: () => fetchChangelog(),
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(CHANGELOG_COPY.title) },
            { name: "robots", content: "noindex" },
        ],
    }),
    component: ChangelogPage,
});
