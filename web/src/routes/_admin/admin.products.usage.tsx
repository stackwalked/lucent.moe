import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { readUsage } from "../../features/admin/system/server.ts";
import { UsagePage } from "../../features/admin/system/UsagePage.tsx";
import { fetchPublicProducts } from "../../features/products/server.ts";

export const Route = createFileRoute("/_admin/admin/products/usage")({
    beforeLoad: ({ context }) => guardSection(context.session, "usage"),
    loader: async () => {
        const [read, catalog] = await Promise.all([readUsage(), fetchPublicProducts()]);
        return { read, catalog };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.usage) }] }),
    component: UsagePage,
});
