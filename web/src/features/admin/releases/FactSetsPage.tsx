import { getRouteApi, Link, useRouteContext } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Ident } from "../../../ui/Ident/Ident.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { memberOf, viewerCan } from "../../../viewer.ts";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { RELEASES_COPY } from "./copy.ts";
import { promoteFactSet } from "./promote.ts";
import { type BuildKey, buildLabel, setStanding } from "./standing.ts";

const route = getRouteApi("/_admin/admin/products/releases/$releaseId");

type Listed = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type BuildRow = Listed["builds"][number];
type SetRow = Listed["sets"][number];

// One module release's fact sets: which revision each game build runs on now, and the sets that
// can still be promoted.
export function FactSetsPage() {
    const listed = route.useLoaderData();
    const { releaseId } = route.useParams();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    if (viewer === null) return null;
    const trail = <Link to="/admin/products/releases">{RELEASES_COPY.title}</Link>;
    if (!listed.ok) {
        return (
            <Page title={RELEASES_COPY.factSets} trail={trail}>
                <RefusalNote refused={listed.refused} />
            </Page>
        );
    }
    const mayPromote = viewerCan(viewer, "facts:promote");
    const { builds, sets } = listed.value;
    return (
        <Page title={RELEASES_COPY.factSets} trail={trail}>
            <Section caption={RELEASES_COPY.release}>
                <Ident value={releaseId} />
            </Section>
            <Section caption={RELEASES_COPY.builds}>
                {builds.length === 0 ? (
                    <Empty>{RELEASES_COPY.noSets}</Empty>
                ) : (
                    <Table
                        caption={RELEASES_COPY.builds}
                        columns={[
                            {
                                key: "build",
                                header: RELEASES_COPY.build,
                                cell: (row: BuildRow) => <Ident value={buildLabel(row.build)} />,
                            },
                            {
                                key: "revision",
                                header: RELEASES_COPY.revision,
                                cell: (row) => row.current?.revision ?? RELEASES_COPY.none,
                            },
                            {
                                key: "promoted",
                                header: RELEASES_COPY.promoted,
                                cell: (row) =>
                                    row.current === null ? null : (
                                        <Time at={row.current.promotedAt} />
                                    ),
                            },
                        ]}
                        rows={builds}
                        rowKey={(row) => buildLabel(row.build)}
                    />
                )}
            </Section>
            {sets.length === 0 ? null : (
                <Section caption={RELEASES_COPY.sets}>
                    <Table
                        caption={RELEASES_COPY.sets}
                        columns={[
                            {
                                key: "revision",
                                header: RELEASES_COPY.revision,
                                cell: (set: SetRow) => set.revision,
                            },
                            {
                                key: "builds",
                                header: RELEASES_COPY.builds,
                                cell: (set) => (
                                    <Stack gap={1}>
                                        {set.builds.map((build: BuildKey) => (
                                            <Ident
                                                key={buildLabel(build)}
                                                value={buildLabel(build)}
                                            />
                                        ))}
                                    </Stack>
                                ),
                            },
                            {
                                key: "staged",
                                header: RELEASES_COPY.staged,
                                cell: (set) => <Time at={set.stagedAt} />,
                            },
                            {
                                key: "state",
                                header: RELEASES_COPY.state,
                                align: "end",
                                cell: (set) => {
                                    const standing = setStanding(set, builds);
                                    if (standing === "current") {
                                        return <Status tone="pink">{RELEASES_COPY.current}</Status>;
                                    }
                                    if (standing !== "promotable" || !mayPromote) return null;
                                    return (
                                        <AccountAction
                                            action="facts:promote"
                                            label={RELEASES_COPY.promote}
                                            title={RELEASES_COPY.promoteRevision(set.revision)}
                                            tone="pink"
                                            fields={
                                                <p>
                                                    {RELEASES_COPY.promoteSetBody(
                                                        set.builds.length,
                                                    )}
                                                </p>
                                            }
                                            run={() =>
                                                promoteFactSet({
                                                    data: { releaseId, setId: set.setId },
                                                })
                                            }
                                        />
                                    );
                                },
                            },
                        ]}
                        rows={sets}
                        rowKey={(set) => set.setId}
                    />
                </Section>
            )}
        </Page>
    );
}
