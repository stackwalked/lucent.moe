import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchListings } from "../../features/cloud/server.ts";
import { fetchShows } from "../../features/privacy/server.ts";
import { ProfilePage } from "../../features/profile/ProfilePage.tsx";
import { fetchProfile, fetchWall } from "../../features/profile/server.ts";
import { PROFILE_TITLE } from "../../features/profile/title.ts";

// The profile, and its wall's first page when the owner shows one to this viewer. `?edit=true`
// (a string, like every search value here) turns the owner's own page into its editor; on anyone
// else's it does nothing. The owner also reads what they show, to see their page as others do.
export const Route = createFileRoute("/_member/members/$username")({
    validateSearch: (search: Record<string, unknown>): { edit?: "true" } =>
        search["edit"] === "true" ? { edit: "true" } : {},
    loader: async ({ params }) => {
        const profile = await fetchProfile({ data: { username: params.username } });
        const wall =
            profile.ok && profile.value.wall
                ? await fetchWall({ data: { username: params.username, cursor: null } })
                : null;
        const shared = profile.ok
            ? await fetchListings({ data: { owner: params.username } })
            : null;
        const shows = profile.ok && profile.value.isSelf ? await fetchShows() : null;
        return { profile, wall, shared, shows };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PROFILE_TITLE) }] }),
    component: ProfilePage,
});
