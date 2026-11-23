import { createFileRoute, Outlet } from "@tanstack/react-router";
import { landing } from "../features/auth/session.ts";
import { toPage } from "../server/route-control.ts";
import { Shell } from "../ui/Shell/Shell.tsx";
import { memberOf } from "../viewer.ts";

// Signing in and setting up: a bare card, no site bar. A member who's already signed in goes on
// to where they were headed, except from /setup: a setup link opened while signed in as someone
// else says so first.
export const Route = createFileRoute("/_auth")({
    beforeLoad: async ({ context, location }) => {
        if (location.pathname === "/setup" || location.pathname === "/reset-password") return;
        if (memberOf(context.session) !== null) toPage(await landing());
    },
    component: () => (
        <Shell layout="bare">
            <Outlet />
        </Shell>
    ),
});
