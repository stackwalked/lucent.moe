import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";
import { routeTree } from "./routeTree.gen.ts";
import type { StartRequestContext } from "./server/request.ts";

// Called by Start once per request on the server, once in the browser. The server router stamps
// the entry's nonce on every script it writes and in a csp-nonce meta tag, which the browser
// router reads back for the scripts it adds later.
export function getRouter() {
    const nonce = getGlobalStartContext()?.nonce;
    return createRouter({
        routeTree,
        scrollRestoration: true,
        defaultPreload: "intent",
        defaultPreloadStaleTime: 10_000,
        // Plain URLSearchParams instead of the router's JSON: the one parameter anything takes is
        // admin lists' ?q=, readable as typed, and an empty one leaves no "?q=" behind.
        parseSearch: (search: string) => Object.fromEntries(new URLSearchParams(search)),
        stringifySearch: (search: Record<string, unknown>) => {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(search)) {
                if (typeof value === "string" && value !== "") params.set(key, value);
            }
            const text = params.toString();
            return text === "" ? "" : `?${text}`;
        },
        ...(nonce === undefined ? {} : { ssr: { nonce } }),
    });
}

declare module "@tanstack/react-router" {
    // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation merges only into an interface
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}

// An admin list's sort and page live in history.state, not the URL: Back and Forward restore
// exactly where you were, and a shared link opens the first page.
declare module "@tanstack/react-router" {
    // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation merges only into an interface
    interface HistoryState {
        sort?: string;
        cursor?: string;
    }
}

declare module "@tanstack/react-start" {
    // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation merges only into an interface
    interface Register {
        server: { requestContext: StartRequestContext | undefined };
    }
}
