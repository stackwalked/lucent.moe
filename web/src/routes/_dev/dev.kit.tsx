import { systemClock } from "@lucent/core/clock";
import { createFileRoute } from "@tanstack/react-router";
import { Kit } from "../../features/dev/Kit.tsx";

export const Route = createFileRoute("/_dev/dev/kit")({
    loader: () => ({ now: systemClock.now() }),
    component: function KitPage() {
        const { now } = Route.useLoaderData();
        return <Kit now={now} />;
    },
});
