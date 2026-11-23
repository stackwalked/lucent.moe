import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { cursorDeps, cursorSearch } from "../../features/comments/cursor.ts";
import { fetchComments } from "../../features/comments/server.ts";
import { GuidePage } from "../../features/guides/GuidePage.tsx";
import { fetchGuide } from "../../features/guides/server.ts";
import { GUIDES_TITLE } from "../../features/guides/title.ts";

export const Route = createFileRoute("/_member/guides/$guideId")({
    validateSearch: cursorSearch,
    loaderDeps: cursorDeps,
    loader: async ({ params, deps }) => {
        const [guide, comments] = await Promise.all([
            fetchGuide({ data: { id: params.guideId } }),
            fetchComments({ data: { guideId: params.guideId, cursor: deps.cursor } }),
        ]);
        return { guide, comments };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(GUIDES_TITLE) }] }),
    component: GuidePage,
});
