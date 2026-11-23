import { getRouteApi } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PRODUCTS_COPY } from "./copy.ts";
import { productName } from "./view.ts";

const route = getRouteApi("/_public/");

export function PublicProductsPage() {
    const catalog = route.useLoaderData();
    return (
        <Page title={SITE_COPY.name} width="narrow">
            <Section caption={PRODUCTS_COPY.title}>
                {!catalog.ok ? (
                    <RefusalNote refused={catalog.refused} />
                ) : catalog.value.length === 0 ? (
                    <Empty>{PRODUCTS_COPY.noneListed}</Empty>
                ) : (
                    <Table
                        caption={PRODUCTS_COPY.title}
                        rows={catalog.value}
                        rowKey={(p) => p.id}
                        columns={[
                            {
                                key: "name",
                                header: PRODUCTS_COPY.product,
                                cell: (p) => productName(p.name),
                            },
                            {
                                key: "state",
                                header: PRODUCTS_COPY.state,
                                cell: (p) => PRODUCTS_COPY.lifecycle[p.state],
                            },
                        ]}
                    />
                )}
            </Section>
        </Page>
    );
}
