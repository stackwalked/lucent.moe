import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AdminShell } from "../features/admin/AdminShell.tsx";
import { isStaff } from "../features/admin/sections.ts";
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
    component: () => (
        <AdminShell>
            <Outlet />
        </AdminShell>
    ),
});
