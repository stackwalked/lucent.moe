import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { OverridesPage } from "../../features/admin/overrides/OverridesPage.tsx";
import { listOverrides } from "../../features/admin/overrides/server.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_admin/admin/products/overrides/$releaseId")({
    beforeLoad: ({ context }) => guardSection(context.session, "overrides"),
    loader: ({ params }) =>
        /^[0-9a-f]{32}$/.test(params.releaseId)
            ? listOverrides({ data: { releaseId: params.releaseId } })
            : toNotFound(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.overrides) }] }),
    component: OverridesPage,
});
