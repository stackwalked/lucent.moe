import { systemClock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import { useState } from "react";
import { Check } from "../../../ui/Check/Check.tsx";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Field } from "../../../ui/Field/Field.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Select } from "../../../ui/Select/Select.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { productName } from "../../products/view.ts";
import { AccountAction } from "./AccountAction.tsx";
import styles from "./AccountPage.module.css";
import { ACCOUNTS_COPY, ENTITLEMENT_STATE_COPY } from "./copy.ts";
import { entitlementState, type GrantForm, parseGrant } from "./grant.ts";
import type { fetchAccount, fetchCatalog } from "./server.ts";
import { issueEntitlement } from "./server.ts";

type Account = Awaited<ReturnType<typeof fetchAccount>>;
type Entitlement = Account["entitlements"][number];
type Catalog = Awaited<ReturnType<typeof fetchCatalog>>;
type Product = Extract<Catalog, { ok: true }>["value"][number];

function readForm(form: FormData): GrantForm {
    return {
        productId: String(form.get("productId") ?? ""),
        channels: form.getAll("channel").map(String),
        features: String(form.get("features") ?? ""),
        until: String(form.get("until") ?? ""),
    };
}

// The product's channels follow the product picked; every one is ticked to start with.
function GrantFields({ products }: { readonly products: readonly Product[] }) {
    const [productId, setProductId] = useState(products[0]?.id ?? "");
    const product = products.find((p) => p.id === productId);
    return (
        <Stack gap={4}>
            <Select
                name="productId"
                label={ACCOUNTS_COPY.product}
                required
                value={productId}
                onChange={setProductId}
                options={products.map((p) => ({ value: p.id, label: productName(p.name) }))}
            />
            <fieldset key={productId} className={styles.channels}>
                <legend className={styles.label}>{ACCOUNTS_COPY.channels}</legend>
                <Stack direction="row" gap={3}>
                    {(product?.channels ?? []).map((channel) => (
                        <Check
                            key={channel}
                            name="channel"
                            value={channel}
                            label={channel}
                            defaultChecked
                        />
                    ))}
                </Stack>
            </fieldset>
            <TextField
                name="features"
                label={ACCOUNTS_COPY.features}
                hint={ACCOUNTS_COPY.featuresHint}
                maxLength={1_024}
            />
            <Field label={ACCOUNTS_COPY.untilOptional}>
                {(control) => <input {...control} type="date" name="until" />}
            </Field>
        </Stack>
    );
}

function Issue({
    account,
    products,
}: {
    readonly account: Account;
    readonly products: readonly Product[];
}) {
    const name = account.username ?? account.email;
    return (
        <AccountAction
            action="entitlements:issue"
            label={ACCOUNTS_COPY.issue}
            title={ACCOUNTS_COPY.issueTitle(name)}
            icon="plus"
            fields={<GrantFields products={products} />}
            validate={(form) => {
                const grant = parseGrant(readForm(form), products, systemClock.now());
                return grant.ok ? undefined : ACCOUNTS_COPY[grant.error];
            }}
            run={(form, operationId) => {
                const grant = parseGrant(readForm(form), products, systemClock.now());
                invariant(grant.ok, "validate let only a readable form through");
                return issueEntitlement({
                    data: {
                        operationId,
                        accountId: account.accountId,
                        validFrom: systemClock.now(),
                        validUntil: grant.value.validUntil,
                        productId: grant.value.productId,
                        features: grant.value.features === "*" ? "*" : [...grant.value.features],
                        channels: [...grant.value.channels],
                    },
                });
            }}
        />
    );
}

function StateBadge({ entitlement }: { readonly entitlement: Entitlement }) {
    const state = entitlementState(entitlement, systemClock.now());
    const tone = state === "active" ? "pink" : state === "upcoming" ? "neutral" : "shu";
    return <Status tone={tone}>{ENTITLEMENT_STATE_COPY[state]}</Status>;
}

// What the account was issued, ended entitlements included, and the form for another when the
// viewer may issue one.
export function Entitlements({
    account,
    catalog,
    canIssue,
}: {
    readonly account: Account;
    readonly catalog: Catalog;
    readonly canIssue: boolean;
}) {
    // The catalog here is what can be issued now: a product retired since shows by its id.
    const names = new Map(
        catalog.ok ? catalog.value.map((p) => [p.id, productName(p.name)] as const) : [],
    );
    return (
        <Section
            caption={ACCOUNTS_COPY.entitlements}
            actions={
                canIssue && catalog.ok && catalog.value.length > 0 ? (
                    <Issue account={account} products={catalog.value} />
                ) : undefined
            }
        >
            {canIssue && !catalog.ok ? <RefusalNote refused={catalog.refused} /> : null}
            {account.entitlements.length === 0 ? (
                <Empty>{ACCOUNTS_COPY.noEntitlements}</Empty>
            ) : (
                <Table
                    caption={ACCOUNTS_COPY.entitlements}
                    columns={[
                        {
                            key: "products",
                            header: ACCOUNTS_COPY.product,
                            cell: (e: Entitlement) =>
                                e.products
                                    .map(
                                        (p) =>
                                            `${names.get(p.productId) ?? p.productId} (${p.channels.join(", ")})`,
                                    )
                                    .join("; "),
                        },
                        {
                            key: "features",
                            header: ACCOUNTS_COPY.features,
                            cell: (e) =>
                                e.products
                                    .map((p) =>
                                        p.features === "*"
                                            ? ACCOUNTS_COPY.allFeatures
                                            : p.features.join(", "),
                                    )
                                    .join("; "),
                        },
                        {
                            key: "from",
                            header: ACCOUNTS_COPY.from,
                            cell: (e) => <Time at={e.validFrom} />,
                        },
                        {
                            key: "until",
                            header: ACCOUNTS_COPY.until,
                            cell: (e) =>
                                e.validUntil === null ? (
                                    ACCOUNTS_COPY.noExpiry
                                ) : (
                                    <Time at={e.validUntil} />
                                ),
                        },
                        {
                            key: "state",
                            header: ACCOUNTS_COPY.entitlementState,
                            align: "end",
                            cell: (e) => <StateBadge entitlement={e} />,
                        },
                    ]}
                    rows={account.entitlements}
                    rowKey={(e) => e.entitlementId}
                />
            )}
        </Section>
    );
}
