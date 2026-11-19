import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { SIGN_IN_COPY } from "../../features/auth/copy.ts";
import { SignInPage } from "../../features/auth/SignInPage.tsx";

export const Route = createFileRoute("/_auth/sign-in")({
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(SIGN_IN_COPY.title) }] }),
    component: SignInPage,
});
