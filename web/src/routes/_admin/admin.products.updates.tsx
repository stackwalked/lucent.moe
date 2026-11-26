import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { listUpdates } from "../../features/admin/updates/server.ts";
import { UpdatesPage } from "../../features/admin/updates/UpdatesPage.tsx";
import { fetchPublicProducts } from "../../features/products/server.ts";

export const Route = createFileRoute("/_admin/admin/updates")({
    beforeLoad: ({ context }) => guardSection(context.session, "updates"),
    loader: async () => {
        const [listed, catalog] = await Promise.all([listUpdates(), fetchPublicProducts()]);
        return { listed, catalog };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.updates) }] }),
    component: UpdatesPage,
});
