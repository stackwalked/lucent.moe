import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { AccountPage } from "../../features/account/AccountPage.tsx";
import { ACCOUNT_COPY } from "../../features/account/copy.ts";
import { fetchAccount } from "../../features/account/server.ts";
import { memberOf } from "../../viewer.ts";

export const Route = createFileRoute("/_member/account/")({
    loader: ({ context }) =>
        fetchAccount({ data: { username: memberOf(context.session)?.username ?? null } }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ACCOUNT_COPY.title) }] }),
    component: AccountPage,
});
