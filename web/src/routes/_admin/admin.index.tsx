import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { listAudit } from "../../features/admin/audit/server.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { queueKinds } from "../../features/admin/queue/merge.ts";
import { QueuePage } from "../../features/admin/queue/QueuePage.tsx";
import { fetchQueueFirst } from "../../features/admin/queue/server.ts";
import { adminSections, toFirstSection } from "../../features/admin/sections.ts";
import { readSystemStatus } from "../../features/admin/system/server.ts";
import { fetchProducts, fetchPublicProducts } from "../../features/products/server.ts";
import { memberOf, viewerCan } from "../../viewer.ts";

// The queue: everything waiting for staff, oldest first, with the products, the system and the
// latest staff actions beside it. A viewer who can work no kind of it starts on the first tab
// they can open instead.
export const Route = createFileRoute("/_admin/admin/")({
    beforeLoad: ({ context }) => {
        const viewer = memberOf(context.session);
        if (viewer === null || !adminSections(viewer).queue) toFirstSection(context.session);
    },
    loader: async ({ context }) => {
        const viewer = memberOf(context.session);
        const kinds = viewer === null ? [] : queueKinds((action) => viewerCan(viewer, action));
        const audits = viewer !== null && viewerCan(viewer, "audit:read");
        const [queue, catalog, products, system, audit] = await Promise.all([
            fetchQueueFirst({ data: { kinds: [...kinds] } }),
            fetchPublicProducts(),
            fetchProducts(),
            audits ? readSystemStatus() : null,
            audits ? listAudit({ data: { q: null, cursor: null } }) : null,
        ]);
        return { queue, catalog, products, system, audit, kinds };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.tabs.queue) }] }),
    component: QueuePage,
});
