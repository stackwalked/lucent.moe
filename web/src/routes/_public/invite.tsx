import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { INVITES_COPY } from "../../features/invites/copy.ts";
import { RedeemPage } from "../../features/invites/RedeemPage.tsx";

export const Route = createFileRoute("/_public/invite")({
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(INVITES_COPY.redeemTitle) },
            { name: "referrer", content: "no-referrer" },
        ],
    }),
    component: RedeemPage,
});
