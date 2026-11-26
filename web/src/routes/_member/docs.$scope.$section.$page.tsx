import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { DOCS } from "../../features/docs/content.ts";
import { DOCS_COPY } from "../../features/docs/copy.ts";
import { DocsPage } from "../../features/docs/DocsPage.tsx";
import { fetchDocScopes } from "../../features/docs/server.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_member/docs/$scope/$section/$page")({
    loader: async ({ params }) => {
        const scopes = await fetchDocScopes();
        const found = DOCS.find((entry) => entry.scope === params.scope);
        const exists = found?.pages.some(
            (page) => page.section === params.section && page.page === params.page,
        );
        if (!scopes.some((entry) => entry.scope === params.scope) || exists !== true) {
            return toNotFound();
        }
        return { scopes, ...params };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(DOCS_COPY.title) }] }),
    component: DocsPage,
});
