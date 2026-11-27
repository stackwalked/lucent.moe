import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "../../ui/Button/Button.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { Entries } from "../changes/Entries.tsx";
import { CLOUD_COPY } from "../cloud/copy.ts";
import { ListingRow } from "../cloud/ListingRow.tsx";
import { PRODUCTS_COPY as C } from "./copy.ts";
import { noteLastProduct } from "./lastProduct.ts";
import { ProductLead } from "./ProductLead.tsx";
import styles from "./ProductPage.module.css";
import { statusWord } from "./view.ts";

const parent = getRouteApi("/_member/products/$productId");
const route = getRouteApi("/_member/products/$productId/");

// One product as the member holds it: its changes on the left; on the right whether it runs
// today and until when theirs lasts, and the loader. The head
// row is the product's own (ProductLead). No version
// rows anywhere: releases carry no version string, only a seal number.
export function ProductPage() {
    const { product, status } = parent.useLoaderData();
    const { changes, loader, cloud } = route.useLoaderData();
    const access = product.access;

    useEffect(() => {
        void noteLastProduct(product.productId);
    }, [product.productId]);

    const now = status.products.find((listed) => listed.productId === product.productId) ?? null;
    const current = statusWord(now?.state ?? product.state, now?.supported ?? null);
    const accessItems = [
        current === null ? null : { label: C.support, value: current.word, tone: current.tone },
        access === null
            ? { label: C.yourAccess, value: C.noAccess }
            : access.validUntil === null
              ? null
              : {
                    label: C.yourAccess,
                    value: (
                        <>
                            {C.until} <Time at={access.validUntil} format="date" />
                        </>
                    ),
                },
    ].filter((item) => item !== null);

    return (
        <Page title={null} hideTitle width="wide">
            <Columns
                head={{ lead: <ProductLead at="changes" /> }}
                main={
                    <Entries
                        first={changes}
                        filter={{ productId: product.productId }}
                        subjectOf={() => null}
                    />
                }
                aside={
                    <Stack gap={6}>
                        <Section caption={C.status}>
                            <Pairs items={accessItems} align="end" />
                        </Section>
                        <Section
                            caption={C.loader}
                            actions={<Link to="/changes/loader">{C.loaderChanges}</Link>}
                        >
                            {loader.ok && loader.value.state === "ready" ? (
                                <form method="get" action="/download/lucent-loader.exe">
                                    <Button type="submit" tone="pink">
                                        {C.download}
                                    </Button>
                                </form>
                            ) : loader.ok && loader.value.state === "no_release" ? (
                                <p className={styles.note}>{C.loaderUnavailable}</p>
                            ) : null}
                        </Section>
                        {cloud === null || !cloud.ok || cloud.value.items.length === 0 ? null : (
                            <Section
                                caption={CLOUD_COPY.newInCloud}
                                actions={
                                    <Link
                                        to="/products/$productId/cloud"
                                        params={{ productId: product.productId }}
                                    >
                                        {CLOUD_COPY.all}
                                    </Link>
                                }
                            >
                                <ul className={styles.names}>
                                    {cloud.value.items.slice(0, 3).map((listing) => (
                                        <ListingRow
                                            key={listing.id}
                                            listing={listing}
                                            variant="brief"
                                        />
                                    ))}
                                </ul>
                            </Section>
                        )}
                    </Stack>
                }
            />
        </Page>
    );
}
