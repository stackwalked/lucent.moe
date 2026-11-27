import { getRouteApi } from "@tanstack/react-router";
import type { Outcome } from "../../../server/outcome.ts";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Find } from "../../../ui/Find/Find.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pager } from "../../../ui/Pager/Pager.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { type Column, Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";

import { ADMIN_COPY, operationLabel } from "../copy.ts";
import { IgnoredTokens } from "../IgnoredTokens.tsx";
import { ListRefusal } from "../ListRefusal.tsx";
import { useListNavigation } from "../list.ts";
import { AUDIT_COPY } from "./copy.ts";
import { type AuditDetail, readAuditQuery } from "./filter.ts";
import type { listAudit } from "./server.ts";

const route = getRouteApi("/_admin/admin/system/audit");

type Listed = Extract<Awaited<ReturnType<typeof listAudit>>, { ok: true }>["value"];
type Entry = Listed["items"][number];

function Detail({ detail }: { readonly detail: AuditDetail }) {
    switch (detail.kind) {
        case "none":
            return null;
        case "reason":
            return detail.reason;
        case "rename":
            return AUDIT_COPY.renamed(detail.from ?? ADMIN_COPY.pending, detail.to);
        case "role":
            return (
                <>
                    {detail.roleId}
                    {detail.expiresAt === null ? null : (
                        <>
                            {" "}
                            {AUDIT_COPY.until} <Time at={detail.expiresAt} />
                        </>
                    )}
                </>
            );
        case "seal":
            return AUDIT_COPY.seal(
                detail.productId,
                detail.channel,
                detail.number,
                detail.previous,
            );
        case "factSet":
            return AUDIT_COPY.factSet(detail.revision, detail.builds);
    }
}

const COLUMNS: readonly Column<Entry>[] = [
    {
        key: "time",
        header: AUDIT_COPY.time,
        cell: (entry) => <Time at={entry.at} format="relative" />,
    },
    {
        key: "actor",
        header: AUDIT_COPY.actor,
        cell: (entry) => (
            <Who
                accountId={entry.actor.id}
                username={entry.actor.username}
                pending={ADMIN_COPY.pending}
            />
        ),
    },
    {
        key: "operation",
        header: AUDIT_COPY.operation,
        cell: (entry) => operationLabel(entry.operation),
    },
    {
        key: "target",
        header: AUDIT_COPY.target,
        cell: (entry) =>
            entry.target.accountId === null ? null : (
                <Who
                    accountId={entry.target.accountId}
                    username={entry.target.username}
                    pending={ADMIN_COPY.pending}
                />
            ),
    },
    {
        key: "detail",
        header: AUDIT_COPY.detail,
        cell: (entry) => <Detail detail={entry.detail} />,
    },
];

function Entries({ outcome }: { readonly outcome: Outcome<Listed> }) {
    const navigation = useListNavigation();
    if (!outcome.ok) return <ListRefusal refused={outcome.refused} />;
    const { items, nextCursor } = outcome.value;
    if (items.length === 0) return <Empty>{AUDIT_COPY.empty}</Empty>;
    return (
        <Stack gap={4}>
            <Table
                caption={AUDIT_COPY.table}
                columns={COLUMNS}
                rows={items}
                rowKey={(entry) => entry.id}
            />
            <Pager nextCursor={nextCursor} onNext={(cursor) => void navigation.next(cursor)} />
        </Stack>
    );
}

export function AuditPage() {
    const outcome = route.useLoaderData();
    const { q } = route.useSearch();
    const navigation = useListNavigation();
    return (
        <Page
            title={AUDIT_COPY.title}
            actions={
                <Find
                    key={q ?? ""}
                    label={AUDIT_COPY.search}
                    placeholder={AUDIT_COPY.searchHint}
                    value={q ?? null}
                    maxLength={200}
                    onFind={(text) => void navigation.filter(text)}
                />
            }
        >
            <Stack gap={5}>
                <IgnoredTokens tokens={readAuditQuery(q).ignored} />
                <Entries outcome={outcome} />
            </Stack>
        </Page>
    );
}
