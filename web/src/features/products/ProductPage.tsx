import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "../../ui/Button/Button.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { ProductPick, type ProductPickRow } from "../../ui/ProductPick/ProductPick.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Tabs } from "../../ui/Tabs/Tabs.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { Entries } from "../changes/Entries.tsx";
import { GuidesSection } from "../guides/GuidesSection.tsx";
import { PRODUCTS_COPY as C } from "./copy.ts";
import { noteLastProduct } from "./lastProduct.ts";
import styles from "./ProductPage.module.css";
import { productName, statusWord } from "./view.ts";

const route = getRouteApi("/_member/products/$productId");

// One product as the member holds it: its changes on the left; on the right whether it runs
// today and until when theirs lasts, what is known broken, the loader, and its guides. The head
// row's title is the product picker, the tabs the page's own (only changes so far). No version
// rows anywhere: releases carry no version string, only a seal number.
export function ProductPage() {
    const data = route.useLoaderData();
    const { product, access, status, issues, changes, loader, guides } = data;

    useEffect(() => {
        void noteLastProduct(product.productId);
    }, [product.productId]);

    const rows: readonly ProductPickRow[] = status.products.map((listed) => ({
        id: listed.productId,
        label: productName(listed.name),
        status: data.held.includes(listed.productId)
            ? statusWord(listed.state, listed.supported)
            : "no-access",
    }));

    const current = statusWord(
        status.current?.state ?? product.state,
        status.current?.supported ?? null,
    );
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
        <Page
            title={
                <ProductPick
                    label={productName(product.name)}
                    rows={rows}
                    current={product.productId}
                    linkFor={(id, children) => (
                        <Link to="/products/$productId" params={{ productId: id }}>
                            {children}
                        </Link>
                    )}
                />
            }
            width="wide"
            tabs={
                <Tabs
                    tabs={[
                        {
                            to: "/products/$productId",
                            params: { productId: product.productId },
                            label: C.changesTab,
                        },
                    ]}
                />
            }
        >
            <Columns
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
                        {issues.length === 0 ? null : (
                            <Section caption={C.issues}>
                                <Stack gap={3}>
                                    {issues.map((issue) => (
                                        <div key={issue.id}>
                                            <p>{issue.title}</p>
                                            {issue.body === "" ? null : (
                                                <p className={styles.issueBody}>{issue.body}</p>
                                            )}
                                        </div>
                                    ))}
                                </Stack>
                            </Section>
                        )}
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
                        <GuidesSection productId={product.productId} outcome={guides} />
                    </Stack>
                }
            />
        </Page>
    );
}
