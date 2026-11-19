import { createFileRoute } from "@tanstack/react-router";

// Public pages need nothing from platform, so they render through its deploys and outages.
export const Route = createFileRoute("/")({
    component: () => <h1>lucent.moe</h1>,
});
