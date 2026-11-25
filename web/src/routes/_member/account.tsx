import { createFileRoute } from "@tanstack/react-router";
import { toPage } from "../../server/route-control.ts";

// /account has no page of its own: it opens on security, its other pages one step away beside it.
export const Route = createFileRoute("/_member/account")({
    beforeLoad: ({ location }) => {
        if (location.pathname === "/account") toPage("/account/security");
    },
});
