import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { CrashesPage } from "../../features/admin/crashes/CrashesPage.tsx";
import { CRASHES_COPY } from "../../features/admin/crashes/copy.ts";
import { listCrashes } from "../../features/admin/crashes/server.ts";
import { listState } from "../../features/admin/list.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { listSearch } from "../../search.ts";

export const Route = createFileRoute("/_admin/admin/products/crashes")({
    beforeLoad: ({ context }) => guardSection(context.session, "crashes"),
    validateSearch: listSearch,
    loaderDeps: ({ search }) => ({ q: search.q }),
    loader: ({ deps, location }) =>
        listCrashes({ data: { q: deps.q ?? null, cursor: listState(location).cursor } }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(CRASHES_COPY.title) }] }),
    component: CrashesPage,
});
