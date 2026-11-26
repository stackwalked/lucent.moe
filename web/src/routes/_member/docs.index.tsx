import { createFileRoute } from "@tanstack/react-router";
import { DOCS } from "../../features/docs/content.ts";
import { fetchDocScopes } from "../../features/docs/server.ts";
import { toNotFound, toPage } from "../../server/route-control.ts";

// /docs is the first page of the first scope this member can open; with no pages there is nothing
// here.
export const Route = createFileRoute("/_member/docs/")({
    beforeLoad: async () => {
        const visible = await fetchDocScopes();
        const first = visible
            .map((entry) => DOCS.find((scope) => scope.scope === entry.scope))
            .find((scope) => scope !== undefined);
        const page = first?.pages[0];
        if (first === undefined || page === undefined) return toNotFound();
        return toPage(`/docs/${first.scope}/${page.section}/${page.page}`);
    },
});
