import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ApplyPage } from "../../features/waitlist/ApplyPage.tsx";
import { WAITLIST_COPY } from "../../features/waitlist/copy.ts";

export const Route = createFileRoute("/_public/apply")({
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(WAITLIST_COPY.title) }] }),
    component: ApplyPage,
});
