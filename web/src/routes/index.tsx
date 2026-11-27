import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../copy/site.ts";
import { APPEAL_PATH } from "../features/appeal/path.ts";
import { fetchChangelog } from "../features/changes/server.ts";
import { fetchListings } from "../features/cloud/server.ts";
import { closedBy } from "../features/comments/closed.ts";
import { fetchStanding } from "../features/comments/server.ts";
import { HomePage } from "../features/home/HomePage.tsx";
import { Landing } from "../features/landing/Landing.tsx";
import preview from "../features/landing/preview.png?url";
import { fetchLoaderOffer, fetchProducts } from "../features/products/server.ts";
import { fetchShouts } from "../features/shouts/server.ts";
import { toPage } from "../server/route-control.ts";
import { toCss } from "../ui/color.ts";
import { resolveTheme } from "../ui/tokens.ts";
import { memberOf } from "../viewer.ts";

// The door: for anyone not signed in, the landing, with no site bar. A member gets home: the
// shout feed with their products, the newest changes and new cloud items beside it. Each part is
// read on its own, and one that is refused leaves its block out rather than the page.
export const Route = createFileRoute("/")({
    beforeLoad: ({ context }) => {
        const session = context.session;
        if (session.state === "signed-in" && session.viewer.purpose === "appeal") {
            toPage(APPEAL_PATH);
        }
    },
    loader: async ({ context }) => {
        if (memberOf(context.session) === null) return null;
        const [shouts, products, loader, changes, listings, standing] = await Promise.all([
            fetchShouts({ data: { productId: null, cursor: null } }),
            fetchProducts(),
            fetchLoaderOffer(),
            fetchChangelog({ data: {} }),
            fetchListings({ data: {} }),
            fetchStanding(),
        ]);
        const closed = standing.ok ? closedBy(standing.value) : null;
        return { shouts, products, loader, changes, listings, closed };
    },
    // Pasted into Discord or anywhere else, the landing shows the mark on the ground and the name.
    head: ({ match }) => {
        if (memberOf(match.context.session) !== null) return {};
        const { origin } = match.context.site;
        return {
            meta: [
                { property: "og:title", content: SITE_COPY.brand },
                { property: "og:type", content: "website" },
                { property: "og:url", content: origin },
                { property: "og:image", content: `${origin}${preview}` },
                { name: "twitter:card", content: "summary_large_image" },
                { name: "theme-color", content: toCss(resolveTheme("graphite").ground) },
            ],
        };
    },
    component: function Home() {
        return Route.useLoaderData() === null ? <Landing /> : <HomePage />;
    },
});
