import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { fetchPrivacy } from "../../features/privacy/server.ts";
import { ProfileEditPage } from "../../features/profile/ProfileEditPage.tsx";
import { fetchProfile } from "../../features/profile/server.ts";
import { PROFILE_TITLE } from "../../features/profile/title.ts";
import { memberOf } from "../../viewer.ts";

export const Route = createFileRoute("/_member/account/profile")({
    loader: async ({ context }) => {
        const username = memberOf(context.session)?.username ?? null;
        const [profile, privacy] = await Promise.all([
            fetchProfile({ data: { username: username ?? "" } }),
            fetchPrivacy({ data: { username } }),
        ]);
        return { profile, privacy };
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PROFILE_TITLE) }] }),
    component: ProfileEditPage,
});
