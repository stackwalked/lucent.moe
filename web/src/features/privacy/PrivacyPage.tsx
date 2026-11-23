import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PRIVACY_COPY, PRIVACY_TITLE } from "./copy.ts";

const route = getRouteApi("/_member/account/privacy");

export function PrivacyPage() {
    const outcome = route.useLoaderData();
    return (
        <Page title={PRIVACY_TITLE} width="narrow">
            <RefusalNote refused={outcome.ok ? null : outcome.refused} />
            {outcome.ok ? (
                <Section caption={PRIVACY_COPY.standing}>
                    {outcome.value.restrictions.length === 0 ? (
                        <Empty>{PRIVACY_COPY.clear}</Empty>
                    ) : (
                        <Table
                            caption={PRIVACY_COPY.restricted}
                            rows={outcome.value.restrictions}
                            rowKey={(row) =>
                                `${row.kind}/${row.productId ?? ""}/${row.endsAt ?? ""}`
                            }
                            columns={[
                                {
                                    key: "kind",
                                    header: PRIVACY_COPY.kind,
                                    cell: (row) => PRIVACY_COPY[row.kind],
                                },
                                {
                                    key: "scope",
                                    header: PRIVACY_COPY.scope,
                                    cell: (row) =>
                                        row.productId === null
                                            ? PRIVACY_COPY.everywhere
                                            : PRIVACY_COPY.inProduct(row.productId),
                                },
                                {
                                    key: "ends",
                                    header: PRIVACY_COPY.ends,
                                    cell: (row) =>
                                        row.endsAt === null ? (
                                            PRIVACY_COPY.untilLifted
                                        ) : (
                                            <>
                                                {PRIVACY_COPY.until} <Time at={row.endsAt} />
                                            </>
                                        ),
                                },
                            ]}
                        />
                    )}
                </Section>
            ) : null}
        </Page>
    );
}
