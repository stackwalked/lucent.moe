import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { readUsage } from "../../features/admin/system/server.ts";
import { UsagePage } from "../../features/admin/system/UsagePage.tsx";

export const Route = createFileRoute("/_admin/admin/usage")({
    beforeLoad: ({ context }) => guardSection(context.session, "usage"),
    loader: () => readUsage(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.usage) }] }),
    component: UsagePage,
});
