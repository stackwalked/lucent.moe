import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { STATUS_COPY } from "../../features/status/copy.ts";
import { StatusPage } from "../../features/status/StatusPage.tsx";
import { fetchStatus } from "../../features/status/server.ts";

export const Route = createFileRoute("/_member/status")({
    loader: () => fetchStatus(),
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(STATUS_COPY.title) },
            { name: "robots", content: "noindex" },
        ],
    }),
    component: StatusPage,
});
