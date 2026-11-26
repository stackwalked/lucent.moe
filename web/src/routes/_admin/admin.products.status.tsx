import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { RECORD_COPY } from "../../features/admin/record/copy.ts";
import { RecordPage } from "../../features/admin/record/RecordPage.tsx";
import { listRecord } from "../../features/admin/record/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/record")({
    beforeLoad: ({ context }) => guardSection(context.session, "record"),
    loader: () => listRecord(),
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(RECORD_COPY.title) },
            { name: "robots", content: "noindex" },
        ],
    }),
    component: RecordPage,
});
