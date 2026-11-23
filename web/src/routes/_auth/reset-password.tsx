import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { RESET_COPY } from "../../features/auth/copy.ts";

export const Route = createFileRoute("/_auth/reset-password")({
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(RESET_COPY.title) },
            { name: "referrer", content: "no-referrer" },
        ],
    }),
});
