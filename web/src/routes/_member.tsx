import { createFileRoute, Outlet } from "@tanstack/react-router";
import { APPEAL_PATH } from "../features/appeal/path.ts";
import { rememberReturnTo } from "../features/auth/session.ts";
import { SiteShell } from "../features/shell/SiteShell.tsx";
import { toPage, toSignIn, toUnavailable } from "../server/route-control.ts";
import { memberOf } from "../viewer.ts";

// Pages for a signed-in member. Anyone else is sent to sign in, and lands back here afterwards; a
// suspended account's appeal session only ever reaches its appeal.
export const Route = createFileRoute("/_member")({
    beforeLoad: async ({ context, location }) => {
        const session = context.session;
        if (session.state === "unavailable") toUnavailable(session.reference);
        if (session.state === "signed-in" && session.viewer.purpose === "appeal") {
            toPage(APPEAL_PATH);
        }
        if (memberOf(session) === null) {
            await rememberReturnTo({ data: { href: location.href } });
            toSignIn();
        }
    },
    component: () => (
        <SiteShell>
            <Outlet />
        </SiteShell>
    ),
});
