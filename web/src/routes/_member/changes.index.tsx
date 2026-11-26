import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ChangesPage } from "../../features/changes/ChangesPage.tsx";
import { CHANGES_COPY } from "../../features/changes/copy.ts";
import { fetchChangelog } from "../../features/changes/server.ts";

export const Route = createFileRoute("/_member/changes/")({
    loader: () => fetchChangelog({ data: {} }),
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(CHANGES_COPY.title) },
            { name: "robots", content: "noindex" },
        ],
    }),
    component: function ChangesIndex() {
        const changes = Route.useLoaderData();
        return <ChangesPage changes={changes} filter={{}} />;
    },
});
