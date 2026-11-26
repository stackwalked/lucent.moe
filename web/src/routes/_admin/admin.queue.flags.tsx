import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { ReviewPage } from "../../features/admin/review/ReviewPage.tsx";
import { listReview } from "../../features/admin/review/server.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/queue/flags")({
    beforeLoad: ({ context }) => guardSection(context.session, "review"),
    loader: () => listReview(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.review) }] }),
    component: ReviewPage,
});
