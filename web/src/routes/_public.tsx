import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SiteShell } from "../features/shell/SiteShell.tsx";

// Pages for everyone. They need nothing from platform beyond who's signed in, so they render
// through platform's deploys and outages.
export const Route = createFileRoute("/_public")({
    component: () => (
        <SiteShell>
            <Outlet />
        </SiteShell>
    ),
});
