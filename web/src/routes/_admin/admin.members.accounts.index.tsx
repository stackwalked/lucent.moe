import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { AccountsPage } from "../../features/admin/accounts/AccountsPage.tsx";
import { ACCOUNTS_COPY } from "../../features/admin/accounts/copy.ts";
import { readAccountQuery } from "../../features/admin/accounts/query.ts";
import { fetchAccounts } from "../../features/admin/accounts/server.ts";
import { listState } from "../../features/admin/list.ts";
import { guardSection } from "../../features/admin/sections.ts";
import { listSearch } from "../../search.ts";

export const Route = createFileRoute("/_admin/admin/members/accounts/")({
    beforeLoad: ({ context }) => guardSection(context.session, "accounts"),
    validateSearch: listSearch,
    loaderDeps: ({ search }) => ({ q: search.q }),
    loader: async ({ deps, location }) => {
        const { status, roleId, text } = readAccountQuery(deps.q);
        const state = listState(location);
        return await fetchAccounts({
            data: {
                status,
                roleId,
                text,
                sort: state.sort === "username" ? "username" : "newest",
                cursor: state.cursor,
            },
        });
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ACCOUNTS_COPY.title) }] }),
    component: AccountsPage,
});
