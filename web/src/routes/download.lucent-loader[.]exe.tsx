import { createFileRoute } from "@tanstack/react-router";
import { downloadLoader } from "../server/platform.ts";

// The loader's file itself, as an attachment: a plain GET the download page's button submits.
export const Route = createFileRoute("/download/lucent-loader.exe")({
    server: {
        handlers: {
            GET: ({ request }) => downloadLoader(request.signal),
        },
    },
});
