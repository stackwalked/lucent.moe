import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { PrivacyPage } from "../../features/privacy/PrivacyPage.tsx";
import { fetchPrivacy } from "../../features/privacy/server.ts";
import { PRIVACY_TITLE } from "../../features/privacy/title.ts";
import { memberOf } from "../../viewer.ts";

export const Route = createFileRoute("/_member/account/privacy")({
    loader: ({ context }) =>
        fetchPrivacy({ data: { username: memberOf(context.session)?.username ?? null } }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PRIVACY_TITLE) }] }),
    component: PrivacyPage,
});
