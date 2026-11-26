import { getRouteApi, Link, useLocation, useRouteContext } from "@tanstack/react-router";
import { Button } from "../../../ui/Button/Button.tsx";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pager } from "../../../ui/Pager/Pager.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { memberOf, viewerCan } from "../../../viewer.ts";
import { ADMIN_COPY } from "../copy.ts";
import { IgnoredTokens } from "../IgnoredTokens.tsx";
import { ListRefusal } from "../ListRefusal.tsx";
import { useListNavigation } from "../list.ts";
import styles from "./AccountsPage.module.css";
import { AddAccount } from "./AddAccount.tsx";
import { ACCOUNTS_COPY } from "./copy.ts";
import { readAccountQuery } from "./query.ts";
import { AccountStatusBadge } from "./status.tsx";

const route = getRouteApi("/_admin/admin/members/accounts/");

type Listed = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Row = Listed["items"][number];

export function AccountsPage() {
    const outcome = route.useLoaderData();
    const { q } = route.useSearch();
    const sort = useLocation({ select: (location) => location.state.sort ?? "newest" });
    const nav = useListNavigation();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const canAdd = viewer !== null && viewerCan(viewer, "accounts:create");
    const sortBy = (next: "newest" | "username") => {
        if (next !== sort) void nav.sort(next);
    };

    return (
        <Page title={ACCOUNTS_COPY.title} {...(canAdd ? { actions: <AddAccount /> } : {})}>
            <Stack gap={4}>
                <form
                    className={styles.filters}
                    onSubmit={(event) => {
                        event.preventDefault();
                        void nav.filter(String(new FormData(event.currentTarget).get("q") ?? ""));
                    }}
                >
                    <div className={styles.search}>
                        <TextField
                            key={q ?? ""}
                            name="q"
                            type="search"
                            label={ACCOUNTS_COPY.search}
                            hint={ACCOUNTS_COPY.searchHint}
                            defaultValue={q ?? ""}
                            maxLength={200}
                        />
                        <IgnoredTokens tokens={readAccountQuery(q).ignored} />
                    </div>
                    <Stack direction="row" gap={1}>
                        <Button
                            size="sm"
                            tone={sort === "newest" ? "plain" : "ghost"}
                            pressed={sort === "newest"}
                            onClick={() => sortBy("newest")}
                        >
                            {ACCOUNTS_COPY.newest}
                        </Button>
                        <Button
                            size="sm"
                            tone={sort === "username" ? "plain" : "ghost"}
                            pressed={sort === "username"}
                            onClick={() => sortBy("username")}
                        >
                            {ACCOUNTS_COPY.byUsername}
                        </Button>
                    </Stack>
                </form>
                {outcome.ok ? (
                    <Accounts page={outcome.value} />
                ) : (
                    <ListRefusal refused={outcome.refused} />
                )}
            </Stack>
        </Page>
    );
}

function Accounts({ page }: { readonly page: Listed }) {
    const nav = useListNavigation();
    return (
        <>
            {page.items.length === 0 ? (
                <Empty>{ACCOUNTS_COPY.noAccounts}</Empty>
            ) : (
                <Table
                    caption={ACCOUNTS_COPY.title}
                    columns={[
                        {
                            key: "username",
                            header: ACCOUNTS_COPY.username,
                            cell: (row: Row) => row.username ?? ADMIN_COPY.pending,
                        },
                        { key: "email", header: ACCOUNTS_COPY.email, cell: (row) => row.email },
                        {
                            key: "status",
                            header: ACCOUNTS_COPY.status,
                            cell: (row) => <AccountStatusBadge status={row.status} />,
                        },
                        {
                            key: "roles",
                            header: ACCOUNTS_COPY.roles,
                            cell: (row) => row.roles.join(", "),
                        },
                        {
                            key: "created",
                            header: ACCOUNTS_COPY.created,
                            cell: (row) => <Time at={row.createdAt} />,
                        },
                        {
                            key: "seen",
                            header: ACCOUNTS_COPY.lastSeen,
                            align: "end",
                            cell: (row) =>
                                row.lastSeenAt === null ? (
                                    ACCOUNTS_COPY.never
                                ) : (
                                    <Time at={row.lastSeenAt} format="relative" />
                                ),
                        },
                    ]}
                    rows={page.items}
                    rowKey={(row) => row.accountId}
                    rowLink={(row, content) => (
                        <Link
                            to="/admin/members/accounts/$accountId"
                            params={{ accountId: row.accountId }}
                            aria-label={row.username ?? row.email}
                        >
                            {content}
                        </Link>
                    )}
                />
            )}
            <Pager nextCursor={page.nextCursor} onNext={(cursor) => void nav.next(cursor)} />
        </>
    );
}
