import { createFileRoute, Outlet, useRouteContext } from "@tanstack/react-router";
import { AdminNav } from "../features/admin/AdminNav.tsx";
import { isStaff } from "../features/admin/sections.ts";
import { SiteShell } from "../features/shell/SiteShell.tsx";
import { toNotFound, toUnavailable } from "../server/route-control.ts";
import { memberOf } from "../viewer.ts";

// Staff pages. Anyone else, signed out included, gets a plain 404: nothing here confirms there's
// an admin area. The guard only steers; every call is decided again by platform.
export const Route = createFileRoute("/_admin")({
    beforeLoad: ({ context }) => {
        const session = context.session;
        if (session.state === "unavailable") toUnavailable(session.reference);
        const viewer = memberOf(session);
        if (viewer === null || !isStaff(viewer)) toNotFound();
    },
    component: AdminFrame,
});

function AdminFrame() {
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    return (
        <SiteShell {...(viewer === null ? {} : { side: <AdminNav viewer={viewer} /> })}>
            <Outlet />
        </SiteShell>
    );
}
