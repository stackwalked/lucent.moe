import { getRouteApi, Link } from "@tanstack/react-router";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { PRODUCTS_COPY } from "./copy.ts";
import { productName } from "./view.ts";

const route = getRouteApi("/_member/products/$productId");

type Channel = ReturnType<typeof route.useLoaderData>["channels"][number];

// One product as the member holds it: what's theirs, on which channels, and whether each runs
// now. A channel with nothing promoted on it is "not yet supported", as after a game update.
export function ProductPage() {
    const product = route.useLoaderData();
    const unsupported = product.channels.some((c) => c.release === null);
    return (
        <Page
            title={productName(product.name)}
            width="narrow"
            trail={<Link to="/products">{PRODUCTS_COPY.title}</Link>}
        >
            <Section caption={PRODUCTS_COPY.product}>
                <Pairs
                    items={[
                        {
                            label: PRODUCTS_COPY.features,
                            value:
                                product.features === "*"
                                    ? PRODUCTS_COPY.allFeatures
                                    : product.features.join(", "),
                        },
                    ]}
                />
            </Section>
            <Section
                caption={PRODUCTS_COPY.channels}
                actions={<Link to="/download">{PRODUCTS_COPY.download}</Link>}
            >
                <Stack gap={3}>
                    <Table
                        caption={PRODUCTS_COPY.channels}
                        columns={[
                            {
                                key: "channel",
                                header: PRODUCTS_COPY.channel,
                                cell: (c: Channel) => c.channel,
                            },
                            {
                                key: "state",
                                header: PRODUCTS_COPY.state,
                                align: "end",
                                cell: (c) =>
                                    c.release === null ? (
                                        <Status tone="shu">{PRODUCTS_COPY.notYetSupported}</Status>
                                    ) : (
                                        <Stack direction="row" gap={2} align="center">
                                            <Status icon="check">{PRODUCTS_COPY.ready}</Status>
                                            <span>
                                                {PRODUCTS_COPY.since}{" "}
                                                <Time at={c.release.promotedAt} />
                                            </span>
                                        </Stack>
                                    ),
                            },
                        ]}
                        rows={product.channels}
                        rowKey={(c) => c.channel}
                    />
                    {unsupported ? <p>{PRODUCTS_COPY.notYetSupportedHint}</p> : null}
                </Stack>
            </Section>
        </Page>
    );
}
