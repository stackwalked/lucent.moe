import { createFileRoute } from "@tanstack/react-router";
import { uploadResource } from "../server/platform.ts";

// A resource's bytes from the admin resources page, streamed on to platform; its answer is the
// digest the page then publishes. Who may upload is platform's to decide.
export const Route = createFileRoute("/admin/resources/upload")({
    server: {
        handlers: {
            POST: ({ request }) => uploadResource(request),
        },
    },
});
