import { BearerToken } from "@lucent/core/scalars";
import { createFileRoute } from "@tanstack/react-router";
import { patchFlow } from "../server/cookies.ts";

// GET /setup/<token> never uses the link up (a GET changes nothing, and a chat app's preview bot
// fetches links too): it keeps the token in the flow cookie and sends the browser on to a plain
// /setup, so the token leaves the address bar and history. Redeeming is /setup's POST.
export const Route = createFileRoute("/setup/$token")({
    server: {
        handlers: {
            GET: ({ params }) => {
                const token = BearerToken.safeParse(params.token);
                if (token.success) patchFlow({ setup: token.data });
                return new Response(null, { status: 303, headers: { location: "/setup" } });
            },
        },
    },
});
