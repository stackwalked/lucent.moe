import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { SECURITY_COPY } from "../../features/security/copy.ts";
import { SecurityPage } from "../../features/security/SecurityPage.tsx";

export const Route = createFileRoute("/_member/account/security")({
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(SECURITY_COPY.title) }] }),
    component: SecurityPage,
});
