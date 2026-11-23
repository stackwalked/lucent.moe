import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { PRIVACY_TITLE } from "../../features/privacy/copy.ts";
import { PrivacyPage } from "../../features/privacy/PrivacyPage.tsx";
import { fetchRestrictions } from "../../features/privacy/server.ts";

export const Route = createFileRoute("/_member/account/privacy")({
    loader: () => fetchRestrictions(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PRIVACY_TITLE) }] }),
    component: PrivacyPage,
});
