import { createFileRoute } from "@tanstack/react-router";
import { DOCS } from "../../features/docs/content.ts";
import { fetchDocScopes } from "../../features/docs/server.ts";
import { toNotFound, toPage } from "../../server/route-control.ts";

// A scope's own address is its first page. One this member cannot open is not found.
export const Route = createFileRoute("/_member/docs/$scope/")({
    beforeLoad: async ({ params }) => {
        const visible = await fetchDocScopes();
        const scope = DOCS.find((entry) => entry.scope === params.scope);
        const page = scope?.pages[0];
        if (!visible.some((entry) => entry.scope === params.scope) || page === undefined) {
            return toNotFound();
        }
        return toPage(`/docs/${params.scope}/${page.section}/${page.page}`);
    },
});
