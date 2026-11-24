import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { RESOURCES_TITLE } from "../../features/resources/copy.ts";
import { ResourcesPage } from "../../features/resources/ResourcesPage.tsx";
import { fetchResources } from "../../features/resources/server.ts";

export const Route = createFileRoute("/_member/resources")({
    loader: () => fetchResources(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(RESOURCES_TITLE) }] }),
    component: ResourcesPage,
});
