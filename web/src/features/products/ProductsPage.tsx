import { getRouteApi, Link } from "@tanstack/react-router";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PRODUCTS_COPY } from "./copy.ts";
import { productName } from "./view.ts";

const route = getRouteApi("/_member/products/");

type Product = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"][number];

export function ProductsPage() {
    const loaded = route.useLoaderData();
    if (!loaded.ok) {
        return (
            <Page title={PRODUCTS_COPY.title}>
                <RefusalNote refused={loaded.refused} />
            </Page>
        );
    }
    const products = loaded.value;
    return (
        <Page
            title={PRODUCTS_COPY.title}
            actions={<Link to="/shouts">{PRODUCTS_COPY.shouts}</Link>}
        >
            <Section caption={PRODUCTS_COPY.title}>
                {products.length === 0 ? (
                    <Empty>{PRODUCTS_COPY.none}</Empty>
                ) : (
                    <Table
                        caption={PRODUCTS_COPY.title}
                        columns={[
                            {
                                key: "name",
                                header: PRODUCTS_COPY.product,
                                cell: (p: Product) => productName(p.name),
                            },
                            {
                                key: "channels",
                                header: PRODUCTS_COPY.channels,
                                cell: (p) => p.channels.map((c) => c.channel).join(", "),
                            },
                            {
                                key: "state",
                                header: PRODUCTS_COPY.state,
                                align: "end",
                                cell: (p) => PRODUCTS_COPY.lifecycle[p.state],
                            },
                        ]}
                        rows={products}
                        rowKey={(p) => p.productId}
                        rowLink={(p, content) => (
                            <Link to="/products/$productId" params={{ productId: p.productId }}>
                                {content}
                            </Link>
                        )}
                    />
                )}
            </Section>
        </Page>
    );
}
