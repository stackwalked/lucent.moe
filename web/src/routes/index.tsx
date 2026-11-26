import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "../features/landing/Landing.tsx";
import { toPage } from "../server/route-control.ts";
import { memberOf } from "../viewer.ts";

// The door: for anyone not signed in, the landing, with no site bar. A member goes on to the
// products until the next step gives them a home.
export const Route = createFileRoute("/")({
    beforeLoad: ({ context }) => {
        if (memberOf(context.session) !== null) toPage("/products");
    },
    component: Landing,
});
