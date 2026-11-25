import { createFileRoute } from "@tanstack/react-router";
import { serveAvatar } from "../server/platform.ts";

// One avatar image by its digest, for an <img>: platform decides whether this member may see it.
export const Route = createFileRoute("/avatars/$digest")({
    server: {
        handlers: {
            GET: ({ request, params }) => serveAvatar(params.digest, request.signal),
        },
    },
});
