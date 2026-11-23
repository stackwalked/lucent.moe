import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { CLOUD_COPY } from "../../features/cloud/copy.ts";
import { SharePage } from "../../features/cloud/SharePage.tsx";
import { fetchCloudProducts } from "../../features/cloud/server.ts";
import { memberOf } from "../../viewer.ts";

// Outside the member redirect: a guest's fragment must never enter a saved return URL.
export const Route = createFileRoute("/_public/share")({
    loader: ({ context }) => (memberOf(context.session) === null ? null : fetchCloudProducts()),
    head: () => ({
        meta: [
            { title: SITE_COPY.pageTitle(CLOUD_COPY.import) },
            { name: "referrer", content: "no-referrer" },
        ],
    }),
    component: SharePage,
});
