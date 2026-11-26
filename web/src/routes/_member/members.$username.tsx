import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchListings } from "../../features/cloud/server.ts";
import { ProfilePage } from "../../features/profile/ProfilePage.tsx";
import { fetchProfile, fetchWall } from "../../features/profile/server.ts";
import { PROFILE_TITLE } from "../../features/profile/title.ts";

// The profile, and its wall's first page when the owner shows one to this viewer.
export const Route = createFileRoute("/_member/members/$username")({
    loader: async ({ params }) => {
        const profile = await fetchProfile({ data: { username: params.username } });
        const wall =
            profile.ok && profile.value.wall
                ? await fetchWall({ data: { username: params.username, cursor: null } })
                : null;
        const shared = profile.ok
            ? await fetchListings({ data: { owner: params.username } })
            : null;
        return { profile, wall, shared };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PROFILE_TITLE) }] }),
    component: ProfilePage,
});
