import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { PREFERENCES_TITLE } from "../../features/preferences/copy.ts";
import { PreferencesPage } from "../../features/preferences/PreferencesPage.tsx";
import { fetchPreferences } from "../../features/preferences/server.ts";

export const Route = createFileRoute("/_member/account/preferences")({
    loader: () => fetchPreferences(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PREFERENCES_TITLE) }] }),
    component: PreferencesPage,
});
