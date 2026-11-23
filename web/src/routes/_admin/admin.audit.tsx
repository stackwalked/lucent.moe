import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { AuditPage } from "../../features/admin/audit/AuditPage.tsx";
import { AUDIT_COPY } from "../../features/admin/audit/copy.ts";
import { listAudit } from "../../features/admin/audit/server.ts";
import { listState } from "../../features/admin/list.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { listSearch } from "../../search.ts";

export const Route = createFileRoute("/_admin/admin/audit")({
    beforeLoad: ({ context }) => guardSection(context.session, "audit"),
    validateSearch: listSearch,
    loaderDeps: ({ search }) => ({ q: search.q }),
    loader: ({ deps, location }) =>
        listAudit({ data: { q: deps.q ?? null, cursor: listState(location).cursor } }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(AUDIT_COPY.title) }] }),
    component: AuditPage,
});
