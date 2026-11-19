import {
    createRootRoute,
    type ErrorComponentProps,
    HeadContent,
    Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { isUnavailable } from "../failure.ts";

// The document every page renders in, error and not-found pages included.
function Document({ children }: { readonly children: ReactNode }) {
    return (
        <html lang="en">
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
    }),
    shellComponent: Document,
    notFoundComponent: NotFound,
    errorComponent: Failure,
});
