import {
    createRootRoute,
    type ErrorComponentProps,
    HeadContent,
    Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { isUnavailable } from "../failure.ts";
import { currentTheme } from "../theme.ts";
import "../ui/global.css";
import "virtual:lucent/tokens.css";
import plex400 from "../ui/fonts/ibm-plex-sans-400.woff2?url";
import plex500 from "../ui/fonts/ibm-plex-sans-500.woff2?url";

// The document every page renders in, error and not-found pages included.
function Document({ children }: { readonly children: ReactNode }) {
    const theme = currentTheme();
    return (
        <html lang="en" {...(theme === "system" ? {} : { "data-theme": theme })}>
            <head>
                <HeadContent />
            </head>
            <body>
                {children}
                <Scripts />
            </body>
        </html>
    );
}

function NotFound() {
    return <p>Not found.</p>;
}

function Failure({ error }: ErrorComponentProps) {
    if (!isUnavailable(error)) return <p>Error.</p>;
    return (
        <p>
            Unavailable. Reference: {error.reference}{" "}
            <button type="button" onClick={() => window.location.reload()}>
                Retry
            </button>
        </p>
    );
}

export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: "lucent.moe" },
        ],
        // Plex only: Geist Mono loads the first time a page shows monospaced text.
        links: [plex400, plex500].map((href) => ({
            rel: "preload",
            href,
            as: "font",
            type: "font/woff2",
            crossOrigin: "anonymous" as const,
        })),
    }),
    shellComponent: Document,
    notFoundComponent: NotFound,
    errorComponent: Failure,
});
