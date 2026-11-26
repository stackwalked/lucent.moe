import type { WebContract } from "@lucent/rpc/web";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { z } from "zod";
import { SITE_COPY } from "../../copy/site.ts";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { UPDATES_COPY } from "../admin/updates/copy.ts";
import { productName } from "../products/view.ts";
import { STATUS_COPY as C } from "./copy.ts";
import { Notes, SnapshotPage } from "./Record.tsx";

const route = getRouteApi("/_member/status");

type PublicRecord = z.output<WebContract["record.status.get"]["output"]>;
type Product = PublicRecord["products"][number];

function StateBadge({ product }: { readonly product: Product }) {
    if (product.state === "announced") return <Status>{C.announced}</Status>;
    if (product.supported === true) return <Status icon="check">{C.supported}</Status>;
    return <Status tone="shu">{C.notYetSupported}</Status>;
}

// Per product the public home lists: whether it works today, what is known to be broken, what
// changed lately and how long each game update took to recover from.
export function StatusPage() {
    const snapshot = route.useLoaderData();
    return (
        <Page title={C.title} width="narrow">
            <SnapshotPage snapshot={snapshot}>
                {(record) => <StatusRecord record={record} />}
            </SnapshotPage>
        </Page>
    );
}

function StatusRecord({ record }: { readonly record: PublicRecord }) {
    const names = new Map<string, string>(
        record.products.map((p) => [p.productId, productName(p.name)]),
    );
    const about = (productId: string | null) =>
        productId === null ? SITE_COPY.name : (names.get(productId) ?? productId);
    const updates = record.products.flatMap((product) =>
        product.recoveries.map((recovery) => ({ product, recovery })),
    );
    return (
        <Stack gap={6}>
            <Section caption={C.products}>
                {record.products.length === 0 ? (
                    <Empty>{C.noProducts}</Empty>
                ) : (
                    <Table
                        caption={C.products}
                        rows={record.products}
                        rowKey={(p) => p.productId}
                        columns={[
                            { key: "name", header: C.product, cell: (p) => productName(p.name) },
                            {
                                key: "state",
                                header: C.state,
                                cell: (p) => <StateBadge product={p} />,
                            },
                        ]}
                    />
                )}
            </Section>
            <Section caption={C.issues}>
                {record.issues.length === 0 ? (
                    <Empty>{C.noIssues}</Empty>
                ) : (
                    <Notes
                        notes={record.issues}
                        meta={(issue) => (
                            <>
                                {about(issue.productId)} · {C.since} <Time at={issue.openedAt} />
                            </>
                        )}
                    />
                )}
            </Section>
            <Section caption={C.changes} actions={<Link to="/changelog">{C.allChanges}</Link>}>
                {record.changelog.length === 0 ? (
                    <Empty>{C.noChanges}</Empty>
                ) : (
                    <Notes
                        notes={record.changelog}
                        meta={(entry) => (
                            <>
                                {about(entry.productId)} · <Time at={entry.publishedAt} />
                            </>
                        )}
                    />
                )}
            </Section>
            <Section caption={C.updates}>
                {updates.length === 0 ? (
                    <Empty>{C.noUpdates}</Empty>
                ) : (
                    <Table
                        caption={C.updates}
                        rows={updates}
                        rowKey={({ product, recovery }) =>
                            `${product.productId}:${recovery.startedAt}`
                        }
                        columns={[
                            {
                                key: "product",
                                header: C.product,
                                cell: ({ product }) => productName(product.name),
                            },
                            {
                                key: "seen",
                                header: C.updateSeen,
                                cell: ({ recovery }) => <Time at={recovery.startedAt} />,
                            },
                            {
                                key: "again",
                                header: C.supportedAgain,
                                cell: ({ recovery }) =>
                                    recovery.endedAt === null ? (
                                        <Status tone="shu">{C.notYetSupported}</Status>
                                    ) : (
                                        <Time at={recovery.endedAt} />
                                    ),
                            },
                            {
                                key: "took",
                                header: C.took,
                                align: "end",
                                cell: ({ recovery }) =>
                                    recovery.latency.state === "covered"
                                        ? UPDATES_COPY.duration(recovery.latency.latencyMs)
                                        : C.open(UPDATES_COPY.duration(recovery.latency.waitingMs)),
                            },
                        ]}
                    />
                )}
            </Section>
        </Stack>
    );
}
