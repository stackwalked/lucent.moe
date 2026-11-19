import { createFileRoute } from "@tanstack/react-router";
import { SignInPage } from "../../features/auth/SignInPage.tsx";

export const Route = createFileRoute("/_auth/sign-in")({
    head: () => ({ meta: [{ title: "Sign in · lucent.moe" }] }),
    component: SignInPage,
});
