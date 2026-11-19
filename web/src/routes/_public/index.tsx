import { createFileRoute } from "@tanstack/react-router";
import { Page } from "../../ui/Page/Page.tsx";

export const Route = createFileRoute("/_public/")({
    component: () => <Page title="lucent.moe">{null}</Page>,
});
