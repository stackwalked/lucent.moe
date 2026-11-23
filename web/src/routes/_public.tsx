import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SiteShell } from "../features/shell/SiteShell.tsx";

export const Route = createFileRoute("/_public")({
    component: () => (
        <SiteShell>
            <Outlet />
        </SiteShell>
    ),
});
