import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Shell } from "../ui/Shell/Shell.tsx";

// Pages for everyone before they have an account to sign in to: apply, an invite, a shared link.
// Bare, like sign-in. They render through platform's deploys and outages: what they read from
// platform is left out when it can't be had, never shown as a refusal.
export const Route = createFileRoute("/_public")({
    component: () => (
        <Shell layout="bare">
            <Outlet />
        </Shell>
    ),
});
