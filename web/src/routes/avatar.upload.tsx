import { createFileRoute } from "@tanstack/react-router";
import { uploadAvatar } from "../server/platform.ts";

// The member's new avatar from their profile page, streamed on to platform; its answer is the
// stored images' digests or why not. Who may set one is platform's to decide.
export const Route = createFileRoute("/avatar/upload")({
    server: {
        handlers: {
            POST: ({ request }) => uploadAvatar(request),
        },
    },
});
