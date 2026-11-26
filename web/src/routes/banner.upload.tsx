import { createFileRoute } from "@tanstack/react-router";
import { uploadBanner } from "../server/platform.ts";

// The member's new banner from their profile page, streamed on to platform; its answer is the
// stored image's digest or why not. Who may set one is platform's to decide.
export const Route = createFileRoute("/banner/upload")({
    server: {
        handlers: {
            POST: ({ request }) => uploadBanner(request),
        },
    },
});
