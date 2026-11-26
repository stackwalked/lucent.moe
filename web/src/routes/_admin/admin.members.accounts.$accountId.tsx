import { isAccountId } from "@lucent/core/brands";
import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { AccountPage } from "../../features/admin/accounts/AccountPage.tsx";
import { ACCOUNTS_COPY } from "../../features/admin/accounts/copy.ts";
import { fetchAccount, fetchCatalog, fetchRoles } from "../../features/admin/accounts/server.ts";
import { fetchInviteStanding } from "../../features/admin/invites/server.ts";
import { fromSearch } from "../../features/admin/queue/from.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { toNotFound } from "../../server/route-control.ts";

export const Route = createFileRoute("/_admin/admin/members/accounts/$accountId")({
    validateSearch: fromSearch,
    beforeLoad: ({ context }) => guardSection(context.session, "accounts"),
    loader: async ({ params }) => {
        const { accountId } = params;
        if (!isAccountId(accountId)) return toNotFound();
        const [account, roles, catalog, invites] = await Promise.all([
            fetchAccount({ data: { accountId } }),
            fetchRoles(),
            fetchCatalog(),
            fetchInviteStanding({ data: { accountId } }),
        ]);
        return { account, roles, catalog, invites };
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
