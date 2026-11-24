import { createFileRoute } from "@tanstack/react-router";
import { downloadResource } from "../server/platform.ts";

// One resource's file, as an attachment: a plain GET the resources page's button submits.
export const Route = createFileRoute("/resources/$resourceId/download")({
    server: {
        handlers: {
            GET: ({ request, params }) => downloadResource(params.resourceId, request.signal),
        },
    },
});
