import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Ident } from "../../../ui/Ident/Ident.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pairs } from "../../../ui/Pairs/Pairs.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { SYSTEM_COPY } from "./copy.ts";

const route = getRouteApi("/_admin/admin/system/jobs");

type Read = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Job = Read["jobs"][number];
type Connections = Read["connections"][number];

function artifactsText(artifacts: Read["artifacts"]) {
    if (artifacts.state === "none") return SYSTEM_COPY.noArtifacts;
    if (artifacts.state === "unreadable") {
        return <Status tone="shu">{SYSTEM_COPY.artifactsUnreadable}</Status>;
    }
    return SYSTEM_COPY.artifactSize(artifacts.files, SYSTEM_COPY.bytes(artifacts.bytes));
}

// The service as the server knows it: what is serving, the jobs it runs on its own, its database
// connections and what waits to go out. Nothing here is collected for the page.
export function SystemPage() {
    const read = route.useLoaderData();
    if (!read.ok) {
        return (
            <Page title={SYSTEM_COPY.title}>
                <RefusalNote refused={read.refused} />
            </Page>
        );
    }
    const { epoch, schema, jobs, connections, mail, artifacts } = read.value;
    return (
        <Page title={SYSTEM_COPY.title}>
            <Section caption={SYSTEM_COPY.service}>
                <Pairs
                    items={[
                        { label: SYSTEM_COPY.epoch, value: epoch },
                        {
                            label: SYSTEM_COPY.schema,
                            value:
                                schema.database === schema.build ? (
                                    SYSTEM_COPY.schemaCurrent(schema.build)
                                ) : (
                                    <Status tone="pink">
                                        {SYSTEM_COPY.schemaApart(schema.database, schema.build)}
                                    </Status>
                                ),
                        },
                        {
                            label: SYSTEM_COPY.mail,
                            value: SYSTEM_COPY.mailCounts(mail.pending, mail.sending),
                        },
                        {
                            label: SYSTEM_COPY.oldestDue,
                            value:
                                mail.oldestDueAt === null ? (
                                    SYSTEM_COPY.none
                                ) : (
                                    <Time at={mail.oldestDueAt} format="relative" />
                                ),
                        },
                        { label: SYSTEM_COPY.artifacts, value: artifactsText(artifacts) },
                    ]}
                />
            </Section>
            <Section caption={SYSTEM_COPY.jobs}>
                {jobs.length === 0 ? (
                    <Empty>{SYSTEM_COPY.noJobs}</Empty>
                ) : (
                    <Table
                        caption={SYSTEM_COPY.jobs}
                        columns={[
                            { key: "job", header: SYSTEM_COPY.job, cell: (job: Job) => job.name },
                            {
                                key: "ran",
                                header: SYSTEM_COPY.lastRun,
                                cell: (job) => <Time at={job.ranAt} format="relative" />,
                            },
                            {
                                key: "duration",
                                header: SYSTEM_COPY.duration,
                                align: "end",
                                cell: (job) => SYSTEM_COPY.milliseconds(job.durationMs),
                            },
                            {
                                key: "state",
                                header: SYSTEM_COPY.state,
                                cell: (job) =>
                                    job.failed ? (
                                        <Status tone="shu" icon="triangle-alert">
                                            {SYSTEM_COPY.failed}
                                        </Status>
                                    ) : (
                                        <Status icon="check">{SYSTEM_COPY.ok}</Status>
                                    ),
                            },
                            {
                                key: "failure",
                                header: SYSTEM_COPY.lastFailure,
                                cell: (job) =>
                                    job.lastFailure === null ? (
                                        SYSTEM_COPY.none
                                    ) : (
                                        <>
                                            <Ident value={job.lastFailure.reason} />{" "}
                                            <Time at={job.lastFailure.at} format="relative" />
                                        </>
                                    ),
                            },
                        ]}
                        rows={jobs}
                        rowKey={(job) => job.name}
                    />
                )}
            </Section>
            <Section caption={SYSTEM_COPY.connections}>
                <Table
                    caption={SYSTEM_COPY.connections}
                    columns={[
                        {
                            key: "application",
                            header: SYSTEM_COPY.application,
                            cell: (row: Connections) =>
                                row.application === "" ? SYSTEM_COPY.unnamed : row.application,
                        },
                        {
                            key: "total",
                            header: SYSTEM_COPY.total,
                            align: "end",
                            cell: (row) => row.total,
                        },
                        {
                            key: "active",
                            header: SYSTEM_COPY.active,
                            align: "end",
                            cell: (row) => row.active,
                        },
                        {
                            key: "idle",
                            header: SYSTEM_COPY.idleInTransaction,
                            align: "end",
                            cell: (row) => row.idleInTransaction,
                        },
                    ]}
                    rows={connections}
                    rowKey={(row) => row.application}
                />
            </Section>
        </Page>
    );
}
