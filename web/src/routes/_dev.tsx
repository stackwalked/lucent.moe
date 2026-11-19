import { createFileRoute, Outlet } from "@tanstack/react-router";
import { toNotFound } from "../server/route-control.ts";

// Pages for building the site itself: they exist only in a dev build. In production the guard
// is a 404, and the pages' code-split chunks are never requested.
export const Route = createFileRoute("/_dev")({
    beforeLoad: () => {
        if (!import.meta.env.DEV) toNotFound();
    },
    component: Outlet,
});
