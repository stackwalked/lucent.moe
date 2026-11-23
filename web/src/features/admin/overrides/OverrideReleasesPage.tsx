import { getRouteApi, Link } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Ident } from "../../../ui/Ident/Ident.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { productName } from "../../products/view.ts";
import { RELEASES_COPY } from "../releases/copy.ts";
import { OVERRIDES_COPY } from "./copy.ts";

const route = getRouteApi("/_admin/admin/overrides/");

type Listed = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Line = Listed[number];
type Seal = Line["seals"][number];

// The module releases a kill switch can be set on, by product and channel.
export function OverrideReleasesPage() {
    const listed = route.useLoaderData();
    if (!listed.ok) {
        return (
            <Page title={OVERRIDES_COPY.title}>
                <RefusalNote refused={listed.refused} />
            </Page>
        );
    }
    const modules = listed.value.filter((line) => line.kind === "module" && line.seals.length > 0);
    return (
        <Page title={OVERRIDES_COPY.title}>
            {modules.length === 0 ? <Empty>{OVERRIDES_COPY.noReleases}</Empty> : null}
            {modules.map((line) => {
                const product = productName(line.name);
                return (
                    <Section
                        key={`${line.productId}:${line.channel}`}
                        caption={OVERRIDES_COPY.line(product, line.channel)}
                    >
                        <Table
                            caption={RELEASES_COPY.seals(product, line.channel)}
                            columns={[
                                {
                                    key: "seal",
                                    header: RELEASES_COPY.seal,
                                    cell: (seal: Seal) => seal.number,
                                },
                                {
                                    key: "release",
                                    header: RELEASES_COPY.release,
                                    cell: (seal) => <Ident value={seal.releaseId} />,
                                },
                                {
                                    key: "state",
                                    header: RELEASES_COPY.state,
                                    cell: (seal) =>
                                        line.current?.number === seal.number ? (
                                            <Status tone="pink">{OVERRIDES_COPY.current}</Status>
                                        ) : null,
                                },
                                {
                                    key: "open",
                                    header: "",
                                    align: "end",
                                    cell: (seal) => (
                                        <Link
                                            to="/admin/overrides/$releaseId"
                                            params={{ releaseId: seal.releaseId }}
                                        >
                                            {OVERRIDES_COPY.open}
                                        </Link>
                                    ),
                                },
                            ]}
                            rows={line.seals}
                            rowKey={(seal) => seal.number}
                        />
                    </Section>
                );
            })}
        </Page>
    );
}
