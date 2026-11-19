import { RoleId } from "@lucent/core/scalars";
import { AccountStatus } from "@lucent/rpc/web";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SITE_COPY } from "../../copy/site.ts";
import { AccountsPage } from "../../features/admin/accounts/AccountsPage.tsx";
import { ACCOUNTS_COPY } from "../../features/admin/accounts/copy.ts";
import { fetchAccounts } from "../../features/admin/accounts/server.ts";
import { listState } from "../../features/admin/list.ts";
import { parseQuery } from "../../features/admin/query.ts";
import { guardSection } from "../../features/admin/sections.ts";

export const ACCOUNT_QUERY_KEYS = ["status", "role"] as const;

export const Route = createFileRoute("/_admin/admin/accounts/")({
    beforeLoad: ({ context }) => guardSection(context.session, "accounts"),
    validateSearch: z.object({ q: z.string().max(200).optional() }),
    loaderDeps: ({ search }) => ({ q: search.q }),
    loader: async ({ deps, location }) => {
        const query = parseQuery(deps.q, ACCOUNT_QUERY_KEYS);
        const status = AccountStatus.safeParse(query.tokens.status);
        const role = RoleId.safeParse(query.tokens.role);
        const state = listState(location);
        return await fetchAccounts({
            data: {
                status: status.success ? status.data : null,
                roleId: role.success ? role.data : null,
                // The contract's limit: longer text is cut rather than refused, like a dropped token.
                text: query.text?.slice(0, 64) ?? null,
                sort: state.sort === "username" ? "username" : "newest",
                cursor: state.cursor,
            },
        });
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(ACCOUNTS_COPY.title) }] }),
    component: AccountsPage,
});
