import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SiteShell } from "../features/shell/SiteShell.tsx";

// Pages for everyone. They render through platform's deploys and outages: what they read from
// platform is left out when it can't be had, never shown as a refusal.
export const Route = createFileRoute("/_public")({
    component: () => (
        <SiteShell>
            <Outlet />
        </SiteShell>
    ),
});
