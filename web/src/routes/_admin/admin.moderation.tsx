import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SITE_COPY } from "../../copy/site.ts";
import { listState } from "../../features/admin/list.ts";
import { ModerationPage } from "../../features/admin/moderation/ModerationPage.tsx";
import { listReports, listRestrictions } from "../../features/admin/moderation/server.ts";
import { MODERATION_TITLE } from "../../features/admin/moderation/title.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/moderation")({
    beforeLoad: ({ context }) => guardSection(context.session, "moderation"),
    validateSearch: z.object({ view: z.enum(["reports", "restrictions"]).optional() }),
    loaderDeps: ({ search }) => ({ view: search.view ?? "reports" }),
    loader: async ({ deps, location }) => {
        const data = { cursor: listState(location).cursor };
        return deps.view === "reports"
            ? { list: { kind: "reports" as const, outcome: await listReports({ data }) } }
            : {
                  list: {
                      kind: "restrictions" as const,
                      outcome: await listRestrictions({ data }),
                  },
              };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(MODERATION_TITLE) }] }),
    component: ModerationPage,
});
