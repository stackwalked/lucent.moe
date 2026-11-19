import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { SETUP_COPY } from "../../features/setup/copy.ts";
import { SetupPage } from "../../features/setup/SetupPage.tsx";

export const Route = createFileRoute("/_auth/setup")({
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(SETUP_COPY.pageTitle) }] }),
    component: SetupPage,
});
