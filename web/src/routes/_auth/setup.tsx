import { createFileRoute } from "@tanstack/react-router";
import { SetupPage } from "../../features/setup/SetupPage.tsx";

export const Route = createFileRoute("/_auth/setup")({
    head: () => ({ meta: [{ title: "Set up · lucent.moe" }] }),
    component: SetupPage,
});
