import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ProfilePage } from "../../features/profile/ProfilePage.tsx";
import { fetchProfile } from "../../features/profile/server.ts";
import { PROFILE_TITLE } from "../../features/profile/title.ts";

export const Route = createFileRoute("/_member/members/$username")({
    loader: ({ params }) => fetchProfile({ data: { username: params.username } }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PROFILE_TITLE) }] }),
    component: ProfilePage,
});
