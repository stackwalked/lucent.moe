import { createFileRoute, Outlet, useMatchRoute, useRouteContext } from "@tanstack/react-router";
import { APPEAL_PATH } from "../features/appeal/path.ts";
import { rememberReturnTo } from "../features/auth/session.ts";
import { DeletionPending } from "../features/privacy/DeletionPending.tsx";
import { AccountNav } from "../features/shell/AccountNav.tsx";
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
    component: MemberFrame,
});

function MemberFrame() {
    const matchRoute = useMatchRoute();
    const onAccount = matchRoute({ to: "/account", fuzzy: true }) !== false;
    const { session } = useRouteContext({ from: "__root__" });
    const dueAt = memberOf(session)?.deletionDueAt ?? null;
    return (
        <SiteShell {...(onAccount ? { side: <AccountNav /> } : {})}>
            {dueAt === null ? null : <DeletionPending dueAt={dueAt} />}
            <Outlet />
        </SiteShell>
    );
}
