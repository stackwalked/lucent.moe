import { AccountId } from "@lucent/core/scalars";
import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { AccountPage } from "../../features/admin/accounts/AccountPage.tsx";
import { ACCOUNTS_COPY } from "../../features/admin/accounts/copy.ts";
import { fetchAccount, fetchRoles } from "../../features/admin/accounts/server.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_admin/admin/accounts/$accountId")({
    beforeLoad: ({ context }) => guardSection(context.session, "accounts"),
    loader: async ({ params }) => {
        const accountId = AccountId.safeParse(params.accountId);
        if (!accountId.success) return toNotFound();
        const [account, roles] = await Promise.all([
            fetchAccount({ data: { accountId: accountId.data } }),
            fetchRoles(),
        ]);
        return { account, roles };
    },
    head: ({ loaderData }) => ({
        meta: [
            {
                title: SITE_COPY.pageTitle(
                    loaderData?.account.username ??
                        loaderData?.account.email ??
                        ACCOUNTS_COPY.title,
                ),
            },
        ],
    }),
    component: AccountPage,
});
