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
        ...(nonce === undefined ? {} : { ssr: { nonce } }),
    });
}

declare module "@tanstack/react-router" {
    // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation merges only into an interface
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}

declare module "@tanstack/react-start" {
    // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation merges only into an interface
    interface Register {
        server: { requestContext: StartRequestContext | undefined };
    }
}
