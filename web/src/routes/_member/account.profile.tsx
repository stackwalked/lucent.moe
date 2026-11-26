import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { ProfileEditPage } from "../../features/profile/ProfileEditPage.tsx";
import { fetchProfile } from "../../features/profile/server.ts";
import { PROFILE_TITLE } from "../../features/profile/title.ts";
import { memberOf } from "../../viewer.ts";

export const Route = createFileRoute("/_member/account/profile")({
    loader: ({ context }) =>
        fetchProfile({ data: { username: memberOf(context.session)?.username ?? "" } }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PROFILE_TITLE) }] }),
    component: ProfileEditPage,
});
