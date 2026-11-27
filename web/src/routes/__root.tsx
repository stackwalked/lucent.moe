import { systemClock } from "@lucent/core/clock";
import {
    createRootRoute,
    type ErrorComponentProps,
    HeadContent,
    Link,
    Scripts,
} from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { SITE_COPY } from "../copy/site.ts";
import { isUnavailable } from "../failure.ts";
import { fetchDocScopes } from "../features/docs/server.ts";
import { fetchUnread } from "../features/inbox/unread.ts";
import { SiteShell } from "../features/shell/SiteShell.tsx";
import { fetchOwnAvatar } from "../features/shell/server.ts";
import { loadSite } from "../features/shell/site.ts";
import { StepUpProvider } from "../features/step-up/StepUp.tsx";
import { currentTheme } from "../theme.ts";
import { currentTimeZone, reportTimeZone } from "../time-zone.ts";
import { Page } from "../ui/Page/Page.tsx";
import { TimeProvider } from "../ui/Time/TimeProvider.tsx";
import { ToastProvider } from "../ui/Toast/Toast.tsx";
import { loadSession, memberOf, rememberSession } from "../viewer.ts";
import "../ui/global.css";
import "virtual:lucent/tokens.css";
import plex400 from "../ui/fonts/ibm-plex-sans-400.woff2?url";
import plex500 from "../ui/fonts/ibm-plex-sans-500.woff2?url";
import favicon from "../ui/Logo/favicon.svg?url";

// The document every page renders in, error and not-found pages included. "now" is the moment
// the page was made, so relative times read the same on the server and after hydration.
function Document({ children }: { readonly children: ReactNode }) {
    const theme = currentTheme();
    const { session, now, timeZone } = Route.useRouteContext();
    useEffect(() => {
        rememberSession(session);
        void reportTimeZone(systemClock.now());
    }, [session]);
    return (
        <html lang="en" {...(theme === "system" ? {} : { "data-theme": theme })}>
            <head>
                <HeadContent />
            </head>
            <body>
                <TimeProvider now={now} timeZone={timeZone}>
                    <ToastProvider>
                        <StepUpProvider>{children}</StepUpProvider>
                    </ToastProvider>
                </TimeProvider>
                <Scripts />
            </body>
        </html>
    );
}

// Inside the site's frame, so the bar is the way on from a dead link.
function NotFound() {
    return (
        <SiteShell>
            <Page title={SITE_COPY.notFound} width="narrow">
                <p>
                    <Link to="/">{SITE_COPY.home}</Link>
                </p>
            </Page>
        </SiteShell>
    );
}

function Failure({ error }: ErrorComponentProps) {
    if (!isUnavailable(error)) return <p>{SITE_COPY.error}</p>;
    return (
        <p>
            {SITE_COPY.unavailable} {SITE_COPY.reference}: {error.reference}{" "}
            <button type="button" onClick={() => window.location.reload()}>
                {SITE_COPY.retry}
            </button>
        </p>
    );
}

export const Route = createRootRoute({
    beforeLoad: async () => {
        const session = await loadSession();
        const viewer = memberOf(session);
        const [unreadCount, avatar] =
            viewer === null
                ? [null, null]
                : await Promise.all([
                      fetchUnread(),
                      viewer.username === null
                          ? null
                          : fetchOwnAvatar({ data: { username: viewer.username } }),
                  ]);
        // The bar's "docs" tab: only when a page exists for a scope this member can open.
        const docs = viewer !== null && (await fetchDocScopes()).length > 0;
        const site = await loadSite();
        return {
            session,
            site,
            unreadCount,
            avatar,
            docs,
            now: systemClock.now(),
            timeZone: currentTimeZone(),
        };
    },
    // Only the signed-out landing is for search engines to index.
    head: ({ match, matches }) => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: SITE_COPY.name },
            ...(matches.at(-1)?.pathname === "/" && memberOf(match.context.session) === null
                ? []
                : [{ name: "robots", content: "noindex" }]),
        ],
        // Plex only: Geist Mono loads the first time a page shows monospaced text.
        links: [
            // The mark, in the tab's own light or dark.
            { rel: "icon", href: favicon, type: "image/svg+xml" },
            ...[plex400, plex500].map((href) => ({
                rel: "preload",
                href,
                as: "font",
                type: "font/woff2",
                crossOrigin: "anonymous" as const,
            })),
        ],
    }),
    shellComponent: Document,
    notFoundComponent: NotFound,
    errorComponent: Failure,
});
