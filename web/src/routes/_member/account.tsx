import { createFileRoute } from "@tanstack/react-router";
import { toPage } from "../../server/route-control.ts";

// /account has no page of its own yet: security is all there is.
export const Route = createFileRoute("/_member/account")({
    beforeLoad: ({ location }) => {
        if (location.pathname === "/account") toPage("/account/security");
    },
});
