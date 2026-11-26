import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pairs } from "../../../ui/Pairs/Pairs.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { productNamer } from "../../products/view.ts";
import { USAGE_COPY } from "./copy.ts";

const route = getRouteApi("/_admin/admin/usage");

type Read = Extract<ReturnType<typeof route.useLoaderData>["read"], { ok: true }>["value"];
type Week = Read["weeks"][number];
type Release = Read["releases"][number];

// Who used what, from the sessions the native path already records: active accounts per product
// per week, and the sessions each release and channel served.
export function UsagePage() {
    const { read, catalog } = route.useLoaderData();
    const nameOf = productNamer(catalog);
    if (!read.ok) {
        return (
            <Page title={USAGE_COPY.title}>
                <RefusalNote refused={read.refused} />
            </Page>
        );
    }
    const { from, until, weeks, releases } = read.value;
    return (
        <Page title={USAGE_COPY.title}>
            <Section caption={USAGE_COPY.window}>
                <Pairs
                    items={[
                        { label: USAGE_COPY.from, value: <Time at={from} /> },
                        { label: USAGE_COPY.until, value: <Time at={until} /> },
                    ]}
                />
            </Section>
            <Section caption={USAGE_COPY.weeks}>
                <p>{USAGE_COPY.weeksNote}</p>
                {weeks.length === 0 ? (
                    <Empty>{USAGE_COPY.noSessions}</Empty>
                ) : (
                    <Table
                        caption={USAGE_COPY.weeks}
                        columns={[
                            {
                                key: "week",
                                header: USAGE_COPY.week,
                                cell: (week: Week) =>
                                    USAGE_COPY.isoWeek(week.isoYear, week.isoWeek),
                            },
                            {
                                key: "product",
                                header: USAGE_COPY.product,
                                cell: (week) => nameOf(week.productId),
                            },
                            {
                                key: "accounts",
                                header: USAGE_COPY.accounts,
                                align: "end",
                                cell: (week) => week.accounts,
                            },
                        ]}
                        rows={weeks}
                        rowKey={(week) => `${week.weekStart}:${week.productId}`}
                    />
                )}
            </Section>
            <Section caption={USAGE_COPY.releases}>
                {releases.length === 0 ? (
                    <Empty>{USAGE_COPY.noSessions}</Empty>
                ) : (
                    <Table
                        caption={USAGE_COPY.releases}
                        columns={[
                            {
                                key: "product",
                                header: USAGE_COPY.product,
                                cell: (release: Release) => nameOf(release.productId),
                            },
                            {
                                key: "channel",
                                header: USAGE_COPY.channel,
                                cell: (release) => release.channel,
                            },
                            {
                                key: "release",
                                header: USAGE_COPY.release,
                                align: "end",
                                cell: (release) => release.number,
                            },
                            {
                                key: "sessions",
                                header: USAGE_COPY.sessions,
                                align: "end",
                                cell: (release) => release.sessions,
                            },
                            {
                                key: "accounts",
                                header: USAGE_COPY.accounts,
                                align: "end",
                                cell: (release) => release.accounts,
                            },
                        ]}
                        rows={releases}
                        rowKey={(release) =>
                            `${release.productId}:${release.channel}:${release.number}`
                        }
                    />
                )}
            </Section>
        </Page>
    );
}
