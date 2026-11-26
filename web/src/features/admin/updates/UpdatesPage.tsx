import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Ident } from "../../../ui/Ident/Ident.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { productNamer } from "../../products/view.ts";
import { buildLabel } from "../releases/standing.ts";
import { UPDATES_COPY } from "./copy.ts";

const route = getRouteApi("/_admin/admin/updates");

type Listed = Extract<ReturnType<typeof route.useLoaderData>["listed"], { ok: true }>["value"];
type Day = Listed["builds"][number];

// Update-day latency per game module build: how long after a start first reported it a fact set
// covering it went current, or how long it has waited.
export function UpdatesPage() {
    const { listed, catalog } = route.useLoaderData();
    const nameOf = productNamer(catalog);
    if (!listed.ok) {
        return (
            <Page title={UPDATES_COPY.title}>
                <RefusalNote refused={listed.refused} />
            </Page>
        );
    }
    const { builds, truncated } = listed.value;
    return (
        <Page title={UPDATES_COPY.title}>
            <Section caption={UPDATES_COPY.builds}>
                {truncated ? <p>{UPDATES_COPY.truncated}</p> : null}
                {builds.length === 0 ? (
                    <Empty>{UPDATES_COPY.nothingReported}</Empty>
                ) : (
                    <Table
                        caption={UPDATES_COPY.builds}
                        columns={[
                            {
                                key: "product",
                                header: UPDATES_COPY.product,
                                cell: (day: Day) => nameOf(day.productId),
                            },
                            {
                                key: "build",
                                header: UPDATES_COPY.build,
                                cell: (day) => <Ident value={buildLabel(day.build)} />,
                            },
                            {
                                key: "reported",
                                header: UPDATES_COPY.reported,
                                cell: (day) => <Time at={day.firstReportedAt} />,
                            },
                            {
                                key: "covered",
                                header: UPDATES_COPY.covered,
                                cell: (day) =>
                                    day.firstCoveredAt === null ? (
                                        UPDATES_COPY.none
                                    ) : (
                                        <Time at={day.firstCoveredAt} />
                                    ),
                            },
                            {
                                key: "latency",
                                header: UPDATES_COPY.latency,
                                align: "end",
                                cell: (day) =>
                                    day.latency.state === "covered" ? (
                                        UPDATES_COPY.duration(day.latency.latencyMs)
                                    ) : (
                                        <Status tone="pink">
                                            {UPDATES_COPY.waiting(
                                                UPDATES_COPY.duration(day.latency.waitingMs),
                                            )}
                                        </Status>
                                    ),
                            },
                        ]}
                        rows={builds}
                        rowKey={(day) => `${day.productId}:${buildLabel(day.build)}`}
                    />
                )}
            </Section>
        </Page>
    );
}
