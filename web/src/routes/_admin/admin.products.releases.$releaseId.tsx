import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ADMIN_COPY } from "../../features/admin/copy.ts";
import { FactSetsPage } from "../../features/admin/releases/FactSetsPage.tsx";
import { listFactSets } from "../../features/admin/releases/server.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_admin/admin/products/releases/$releaseId")({
    beforeLoad: ({ context }) => guardSection(context.session, "releases"),
    loader: ({ params }) =>
        /^[0-9a-f]{32}$/.test(params.releaseId)
            ? listFactSets({ data: { releaseId: params.releaseId } })
            : toNotFound(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ADMIN_COPY.releases) }] }),
    component: FactSetsPage,
});
