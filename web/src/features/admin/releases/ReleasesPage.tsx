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
import { productName } from "../../products/view.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { RELEASES_COPY } from "./copy.ts";
import { promoteRelease } from "./promote.ts";

const route = getRouteApi("/_admin/admin/products/releases/");

type Listed = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Line = Listed[number];
type Seal = Line["seals"][number];

// Each product and channel: its current seal and the staged ones above it. Only those can be
// promoted; a seal below the current one is never listed, since clients would refuse it.
export function ReleasesPage() {
    const listed = route.useLoaderData();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    if (viewer === null) return null;
    const mayPromote = viewerCan(viewer, "releases:promote");
    return (
        <Page title={RELEASES_COPY.title}>
            {listed.ok ? (
                listed.value.map((line) => (
                    <Section
                        key={`${line.productId}:${line.channel}`}
                        caption={RELEASES_COPY.line(productName(line.name), line.channel)}
                    >
                        <Seals line={line} mayPromote={mayPromote} />
                    </Section>
                ))
            ) : (
                <RefusalNote refused={listed.refused} />
            )}
        </Page>
    );
}

function Seals({ line, mayPromote }: { readonly line: Line; readonly mayPromote: boolean }) {
    if (line.seals.length === 0) return <Empty>{RELEASES_COPY.nothingStaged}</Empty>;
    const isCurrent = (seal: Seal) => line.current?.number === seal.number;
    const product = productName(line.name);
    return (
        <Table
            caption={RELEASES_COPY.seals(product, line.channel)}
            columns={[
                { key: "seal", header: RELEASES_COPY.seal, cell: (seal: Seal) => seal.number },
                {
                    key: "release",
                    header: RELEASES_COPY.release,
                    cell: (seal) => <Ident value={seal.releaseId} />,
                },
                {
                    key: "staged",
                    header: RELEASES_COPY.staged,
                    cell: (seal) => <Time at={seal.stagedAt} />,
                },
                {
                    key: "state",
                    header: RELEASES_COPY.state,
                    cell: (seal) =>
                        isCurrent(seal) && line.current !== null ? (
                            <Stack direction="row" gap={2} align="center">
                                <Status tone="pink">{RELEASES_COPY.current}</Status>
                                <Time at={line.current.promotedAt} />
                            </Stack>
                        ) : null,
                },
                {
                    key: "actions",
                    header: "",
                    align: "end",
                    cell: (seal) => (
                        <Stack direction="row" gap={2} align="center">
                            {line.kind === "module" ? (
                                <Link
                                    to="/admin/products/releases/$releaseId"
                                    params={{ releaseId: seal.releaseId }}
                                >
                                    {RELEASES_COPY.factSets}
                                </Link>
                            ) : null}
                            {mayPromote && !isCurrent(seal) ? (
                                <AccountAction
                                    action="releases:promote"
                                    label={RELEASES_COPY.promote}
                                    title={RELEASES_COPY.promoteSeal(seal.number)}
                                    tone="pink"
                                    fields={
                                        <p>
                                            {RELEASES_COPY.promoteSealBody(product, line.channel)}
                                        </p>
                                    }
                                    run={() =>
                                        promoteRelease({
                                            data: {
                                                productId: line.productId,
                                                channel: line.channel,
                                                number: seal.number,
                                            },
                                        })
                                    }
                                />
                            ) : null}
                        </Stack>
                    ),
                },
            ]}
            rows={line.seals}
            rowKey={(seal) => seal.number}
        />
    );
}
