import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { COMMUNITY_COPY } from "../../features/community/copy.ts";
import { MembersPage } from "../../features/community/MembersPage.tsx";
import { communitySearch } from "../../features/community/search.ts";
import { fetchMembers } from "../../features/community/server.ts";

// The members, in member-number order, narrowed by ?find= (a username prefix); the three newest
// come from the same list sorted the other way.
export const Route = createFileRoute("/_member/community/")({
    validateSearch: communitySearch,
    loaderDeps: ({ search }) => ({ find: search.find ?? null }),
    loader: async ({ deps }) => {
        const [members, newest] = await Promise.all([
            fetchMembers({ data: deps.find === null ? {} : { text: deps.find } }),
            fetchMembers({ data: { sort: "newest" } }),
        ]);
        return { find: deps.find, members, newest };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(COMMUNITY_COPY.title) }] }),
    component: function Community() {
        return <MembersPage data={Route.useLoaderData()} />;
    },
});
