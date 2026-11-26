import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AdminShell } from "../features/admin/AdminShell.tsx";
import { fetchQueueCounts } from "../features/admin/queue/counts.ts";
import { queueKinds } from "../features/admin/queue/merge.ts";
import { isStaff } from "../features/admin/sections.ts";
import { toNotFound, toUnavailable } from "../server/route-control.ts";
import { memberOf, viewerCan } from "../viewer.ts";

// Staff pages. Anyone else, signed out included, gets a plain 404: nothing here confirms there's
// an admin area. The guard only steers; every call is decided again by platform.
export const Route = createFileRoute("/_admin")({
    beforeLoad: ({ context }) => {
        const session = context.session;
        if (session.state === "unavailable") toUnavailable(session.reference);
        const viewer = memberOf(session);
        if (viewer === null || !isStaff(viewer)) toNotFound();
    },
    loader: async ({ context }) => {
        const viewer = memberOf(context.session);
        const kinds = viewer === null ? [] : queueKinds((action) => viewerCan(viewer, action));
        return await fetchQueueCounts({ data: { kinds: [...kinds] } });
    },
    component: () => (
        <AdminShell>
            <Outlet />
        </AdminShell>
    ),
});
