import { getRouteApi, Link } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { APPLICATIONS_COPY } from "./copy.ts";

const route = getRouteApi("/_admin/admin/queue/applications/");

type Listed = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Half = Listed["pending"];
type Item = Half["items"][number];

// The waitlist as staff work it: the oldest applications first, then the latest decided.
export function ApplicationsPage() {
    const listed = route.useLoaderData();
    if (!listed.ok) {
        return (
            <Page title={APPLICATIONS_COPY.title}>
                <RefusalNote refused={listed.refused} />
            </Page>
        );
    }
    const { pending, approved, declined } = listed.value;
    return (
        <Page title={APPLICATIONS_COPY.title}>
            <Applications
                caption={APPLICATIONS_COPY.pending}
                half={pending}
                empty={APPLICATIONS_COPY.nonePending}
                truncated={APPLICATIONS_COPY.truncated}
                at="applied"
            />
            <Applications
                caption={APPLICATIONS_COPY.approved}
                half={approved}
                empty={APPLICATIONS_COPY.noneDecided}
                truncated={APPLICATIONS_COPY.truncatedDecided}
                at="decided"
            />
            <Applications
                caption={APPLICATIONS_COPY.declined}
                half={declined}
                empty={APPLICATIONS_COPY.noneDecided}
                truncated={APPLICATIONS_COPY.truncatedDecided}
                at="decided"
            />
        </Page>
    );
}

function Applications({
    caption,
    half,
    empty,
    truncated,
    at,
}: {
    readonly caption: string;
    readonly half: Half;
    readonly empty: string;
    readonly truncated: string;
    readonly at: "applied" | "decided";
}) {
    return (
        <Section caption={caption}>
            {half.truncated ? <p>{truncated}</p> : null}
            {half.items.length === 0 ? (
                <Empty>{empty}</Empty>
            ) : (
                <Table
                    caption={caption}
                    rows={half.items}
                    rowKey={(item) => item.applicationId}
                    columns={[
                        {
                            key: "email",
                            header: APPLICATIONS_COPY.email,
                            cell: (item: Item) => (
                                <Link
                                    to="/admin/queue/applications/$applicationId"
                                    params={{ applicationId: item.applicationId }}
                                >
                                    {item.email}
                                </Link>
                            ),
                        },
                        {
                            key: "games",
                            header: APPLICATIONS_COPY.games,
                            cell: (item) => item.games,
                        },
                        {
                            key: "at",
                            header: APPLICATIONS_COPY[at],
                            cell: (item) => {
                                const when = at === "applied" ? item.createdAt : item.decidedAt;
                                return when === null ? null : <Time at={when} format="relative" />;
                            },
                        },
                        {
                            key: "account",
                            header: "",
                            align: "end",
                            cell: (item) =>
                                item.state !== "pending" ? null : item.emailHasAccount ? (
                                    <Status tone="shu">{APPLICATIONS_COPY.account}</Status>
                                ) : item.returningAccountId == null ? null : (
                                    <Status tone="shu">{APPLICATIONS_COPY.returning}</Status>
                                ),
                        },
                    ]}
                />
            )}
        </Section>
    );
}
