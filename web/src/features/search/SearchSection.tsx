import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome } from "../../server/outcome.ts";
import { Named } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { SEARCH_COPY } from "./copy.ts";
import { searchCommunity } from "./server.ts";

type Found = Extract<Awaited<ReturnType<typeof searchCommunity>>, { ok: true }>["value"];

// Guides and accounts, searched where a member already is. The answer stays in this section: a
// search is a question, not a place to link to.
export function SearchSection() {
    const [found, setFound] = useState<Outcome<Found> | null>(null);
    const search = async (form: FormData) => {
        const q = String(form.get("q") ?? "").trim();
        if (q !== "") setFound(await searchCommunity({ data: { q } }));
    };
    return (
        <Section caption={SEARCH_COPY.title}>
            <Stack gap={4}>
                <search>
                    <form action={search}>
                        <Stack direction="row" gap={2} align="end">
                            <TextField
                                name="q"
                                type="search"
                                label={SEARCH_COPY.field}
                                maxLength={64}
                                required
                            />
                            <Button type="submit">{SEARCH_COPY.go}</Button>
                        </Stack>
                    </form>
                </search>
                {found === null ? null : !found.ok ? (
                    <RefusalNote refused={found.refused} />
                ) : (
                    <Stack gap={4}>
                        {found.value.guides.length === 0 ? (
                            <Empty>{SEARCH_COPY.noGuides}</Empty>
                        ) : (
                            <Table
                                caption={SEARCH_COPY.table}
                                rows={found.value.guides}
                                rowKey={(row) => row.id}
                                columns={[
                                    {
                                        key: "guide",
                                        header: SEARCH_COPY.guide,
                                        cell: (row) => (
                                            <Link
                                                to="/guides/$guideId"
                                                params={{ guideId: row.id }}
                                            >
                                                {row.title}
                                            </Link>
                                        ),
                                    },
                                    {
                                        key: "product",
                                        header: SEARCH_COPY.product,
                                        cell: (row) => row.productId,
                                    },
                                    {
                                        key: "author",
                                        header: SEARCH_COPY.author,
                                        cell: (row) => (
                                            <Named avatar={row.author.avatar}>
                                                {row.author.username ?? "—"}
                                            </Named>
                                        ),
                                    },
                                ]}
                            />
                        )}
                        {found.value.accounts.length === 0 ? (
                            <Empty>{SEARCH_COPY.noAccounts}</Empty>
                        ) : (
                            <Table
                                caption={SEARCH_COPY.accountsTable}
                                rows={found.value.accounts}
                                rowKey={(row) => row.username}
                                columns={[
                                    {
                                        key: "account",
                                        header: SEARCH_COPY.accounts,
                                        cell: (row) => (
                                            <Link
                                                to="/members/$username"
                                                params={{ username: row.username }}
                                            >
                                                {row.username}
                                            </Link>
                                        ),
                                    },
                                ]}
                            />
                        )}
                    </Stack>
                )}
            </Stack>
        </Section>
    );
}
