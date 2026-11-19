import { createFileRoute, Outlet } from "@tanstack/react-router";
import { rememberReturnTo } from "../features/auth/session.ts";
import { SiteShell } from "../features/shell/SiteShell.tsx";
import { toSignIn, toUnavailable } from "../server/route-control.ts";
import { memberOf } from "../viewer.ts";

// Pages for a signed-in member. Anyone else is sent to sign in, and lands back here afterwards.
export const Route = createFileRoute("/_member")({
    beforeLoad: async ({ context, location }) => {
        const session = context.session;
        if (session.state === "unavailable") toUnavailable(session.reference);
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
