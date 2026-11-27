import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ChangelogPage } from "../../features/admin/changelog/ChangelogPage.tsx";
import { CHANGELOG_COPY } from "../../features/admin/changelog/copy.ts";
import { listChangelog } from "../../features/admin/changelog/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/products/changelog")({
    beforeLoad: ({ context }) => guardSection(context.session, "changelog"),
    loader: () => listChangelog(),
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(CHANGELOG_COPY.title) },
            { name: "robots", content: "noindex" },
        ],
    }),
    component: ChangelogPage,
});
