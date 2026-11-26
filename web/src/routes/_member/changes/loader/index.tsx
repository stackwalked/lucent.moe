import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../../../copy/site.ts";
import { ChangesPage } from "../../../../features/changes/ChangesPage.tsx";
import { CHANGES_COPY } from "../../../../features/changes/copy.ts";
import { fetchChangelog } from "../../../../features/changes/server.ts";

export const Route = createFileRoute("/_member/changes/loader/")({
    loader: () => fetchChangelog({ data: { subject: "loader" } }),
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(CHANGES_COPY.loaderTitle) },
            { name: "robots", content: "noindex" },
        ],
    }),
    component: function LoaderChanges() {
        const changes = Route.useLoaderData();
        return <ChangesPage changes={changes} filter={{ subject: "loader" }} loaderOnly />;
    },
});
