import { createFileRoute } from "@tanstack/react-router";
import { streamCommunityEvents } from "../server/platform.ts";

// The community event stream (who is here now), proxied for the signed-in member; platform
// decides what each account may be named in. Signed out is a 401 with no body.
export const Route = createFileRoute("/community/events")({
    server: {
        handlers: {
            GET: ({ request }) => streamCommunityEvents(request.signal),
        },
    },
});
