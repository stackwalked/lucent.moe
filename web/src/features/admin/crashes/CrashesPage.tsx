import { getRouteApi, Link } from "@tanstack/react-router";
import type { Outcome } from "../../../server/outcome.ts";
import { Button } from "../../../ui/Button/Button.tsx";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pager } from "../../../ui/Pager/Pager.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { type Column, Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { IgnoredTokens } from "../IgnoredTokens.tsx";
import { ListRefusal } from "../ListRefusal.tsx";
import { useListNavigation } from "../list.ts";
import { CRASHES_COPY } from "./copy.ts";
import { readCrashesQuery } from "./filter.ts";
import type { listCrashes } from "./server.ts";

const route = getRouteApi("/_admin/admin/crashes");

type Listed = Extract<Awaited<ReturnType<typeof listCrashes>>, { ok: true }>["value"];
type Summary = Listed["items"][number];

const COLUMNS: readonly Column<Summary>[] = [
    {
        key: "release",
        header: CRASHES_COPY.release,
        cell: (summary) => (
            <Link to="/admin/crashes" search={{ q: `release:${summary.releaseId}` }}>
                {CRASHES_COPY.releaseName(summary.productId, summary.channel, summary.sealNumber)}
            </Link>
        ),
    },
    {
        key: "where",
        header: CRASHES_COPY.where,
        cell: (summary) => <code>{CRASHES_COPY.place(summary.moduleHash, summary.rva)}</code>,
    },
    {
        key: "exception",
        header: CRASHES_COPY.exception,
        cell: (summary) => <code>{CRASHES_COPY.hex(summary.exceptionCode)}</code>,
    },
    {
        key: "frames",
        header: CRASHES_COPY.frames,
        cell: (summary) => (
            <code>
                {summary.frames.length === 0
                    ? CRASHES_COPY.noFrames
                    : summary.frames.map(CRASHES_COPY.hex).join(" ")}
            </code>
        ),
    },
    {
        key: "crashes",
        header: CRASHES_COPY.crashes,
        align: "end",
        cell: (summary) => summary.crashes,
    },
    {
        key: "first",
        header: CRASHES_COPY.first,
        cell: (summary) => <Time at={summary.firstAt} format="relative" />,
    },
    {
        key: "last",
        header: CRASHES_COPY.last,
        cell: (summary) => <Time at={summary.lastAt} format="relative" />,
    },
];

function Summaries({ outcome }: { readonly outcome: Outcome<Listed> }) {
    const navigation = useListNavigation();
    if (!outcome.ok) return <ListRefusal refused={outcome.refused} />;
    const { items, nextCursor } = outcome.value;
    if (items.length === 0) return <Empty>{CRASHES_COPY.empty}</Empty>;
    return (
        <Stack gap={4}>
            <Table
                caption={CRASHES_COPY.table}
                columns={COLUMNS}
                rows={items}
                rowKey={(summary) =>
                    `${summary.releaseId}:${summary.moduleHash}:${String(summary.rva)}`
                }
            />
            <Pager nextCursor={nextCursor} onNext={(cursor) => void navigation.next(cursor)} />
        </Stack>
    );
}

// What modules reported crashing, per release and place, the place with the newest crash first.
export function CrashesPage() {
    const outcome = route.useLoaderData();
    const { q } = route.useSearch();
    const navigation = useListNavigation();
    const search = (form: FormData) => {
        const value = form.get("q");
        if (typeof value === "string") void navigation.filter(value);
    };
    return (
        <Page title={CRASHES_COPY.title}>
            <Stack gap={5}>
                <search>
                    <form action={search}>
                        <Stack direction="row" gap={2} align="end">
                            <TextField
                                key={q ?? ""}
                                name="q"
                                type="search"
                                label={CRASHES_COPY.search}
                                hint={CRASHES_COPY.searchHint}
                                defaultValue={q ?? ""}
                                maxLength={200}
                            />
                            <Button type="submit">{CRASHES_COPY.search}</Button>
                        </Stack>
                    </form>
                    <IgnoredTokens tokens={readCrashesQuery(q).ignored} />
                </search>
                <Summaries outcome={outcome} />
            </Stack>
        </Page>
    );
}
