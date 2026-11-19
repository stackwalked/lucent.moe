import { createFileRoute } from "@tanstack/react-router";
import { SecurityPage } from "../../features/security/SecurityPage.tsx";

export const Route = createFileRoute("/_member/account/security")({
    head: () => ({ meta: [{ title: "Security · lucent.moe" }] }),
    component: SecurityPage,
});
