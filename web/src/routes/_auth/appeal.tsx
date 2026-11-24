import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { AppealPage } from "../../features/appeal/AppealPage.tsx";
import { APPEAL_TITLE } from "../../features/appeal/copy.ts";
import { fetchAppeal } from "../../features/appeal/server.ts";
import { toPage, toSignIn, toUnavailable } from "../../server/route-control.ts";
import { memberOf } from "../../viewer.ts";

// Only an appeal session's page: a member goes home, anyone else to sign in.
export const Route = createFileRoute("/_auth/appeal")({
    beforeLoad: ({ context }) => {
        const session = context.session;
        if (session.state === "unavailable") toUnavailable(session.reference);
        if (memberOf(session) !== null) toPage("/");
        if (session.state !== "signed-in" || session.viewer.purpose !== "appeal") toSignIn();
    },
    loader: () => fetchAppeal(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(APPEAL_TITLE) }] }),
    component: AppealPage,
});
