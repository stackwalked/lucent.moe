import { createFileRoute } from "@tanstack/react-router";
import { APPEAL_PATH } from "../features/appeal/path.ts";
import { fetchChangelog } from "../features/changes/server.ts";
import { fetchListings } from "../features/cloud/server.ts";
import { HomePage } from "../features/home/HomePage.tsx";
import { Landing } from "../features/landing/Landing.tsx";
import { fetchLoaderOffer, fetchProducts } from "../features/products/server.ts";
import { fetchShouts } from "../features/shouts/server.ts";
import { toPage } from "../server/route-control.ts";
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
        const [shouts, products, loader, changes, listings] = await Promise.all([
            fetchShouts({ data: { productId: null, cursor: null } }),
            fetchProducts(),
            fetchLoaderOffer(),
            fetchChangelog({ data: {} }),
            fetchListings({ data: {} }),
        ]);
        return { shouts, products, loader, changes, listings };
    },
    component: function Home() {
        return Route.useLoaderData() === null ? <Landing /> : <HomePage />;
    },
});
