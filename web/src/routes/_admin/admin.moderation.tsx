import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { listState } from "../../features/admin/list.ts";
import { ModerationPage } from "../../features/admin/moderation/ModerationPage.tsx";
import { moderationSearch } from "../../features/admin/moderation/search.ts";
import { listReports, listRestrictions } from "../../features/admin/moderation/server.ts";
import { MODERATION_TITLE } from "../../features/admin/moderation/title.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { fetchPublicProducts } from "../../features/products/server.ts";

// The restrict form picks from the public catalog: a restriction can name any product.
async function restrictionsWithProducts(data: { readonly cursor: string | null }) {
    const [outcome, products] = await Promise.all([
        listRestrictions({ data }),
        fetchPublicProducts(),
    ]);
    return { outcome, products };
}

export const Route = createFileRoute("/_admin/admin/moderation")({
    beforeLoad: ({ context }) => guardSection(context.session, "moderation"),
    validateSearch: moderationSearch,
    loaderDeps: ({ search }) => ({ view: search.view ?? "reports" }),
    loader: async ({ deps, location }) => {
        const data = { cursor: listState(location).cursor };
        return deps.view === "reports"
            ? { list: { kind: "reports" as const, outcome: await listReports({ data }) } }
            : {
                  list: {
                      kind: "restrictions" as const,
                      ...(await restrictionsWithProducts(data)),
                  },
              };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(MODERATION_TITLE) }] }),
    component: ModerationPage,
});
