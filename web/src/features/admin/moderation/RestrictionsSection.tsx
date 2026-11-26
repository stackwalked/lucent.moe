import { isProductId } from "@lucent/core/brands";
import type { Outcome } from "../../../server/outcome.ts";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Field } from "../../../ui/Field/Field.tsx";
import { Pager } from "../../../ui/Pager/Pager.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Select } from "../../../ui/Select/Select.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { ProductSelect } from "../../products/ProductSelect.tsx";
import type { fetchPublicProducts } from "../../products/server.ts";
import { productName } from "../../products/view.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { untilFrom } from "../accounts/until.ts";
import { ADMIN_COPY } from "../copy.ts";
import { ListRefusal } from "../ListRefusal.tsx";
import { useListNavigation } from "../list.ts";
import { MODERATION_COPY } from "./copy.ts";
import type { listRestrictions } from "./server.ts";
import { liftRestriction, restrictAccount } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof listRestrictions>>, { ok: true }>["value"];
type Products = Awaited<ReturnType<typeof fetchPublicProducts>>;

function RestrictForm({ products }: { readonly products: Products }) {
    return (
        <>
            <TextField name="username" label={MODERATION_COPY.username} required maxLength={64} />
            <Select
                name="kind"
                label={MODERATION_COPY.kind}
                required
                options={[
                    { value: "muted", label: MODERATION_COPY.muted },
                    { value: "barred", label: MODERATION_COPY.barred },
                ]}
            />
            {products.ok ? (
                <ProductSelect
                    name="product"
                    label={MODERATION_COPY.product}
                    none={MODERATION_COPY.everywhere}
                    products={products.value.map((p) => ({ productId: p.id, name: p.name }))}
                />
            ) : (
                <RefusalNote refused={products.refused} />
            )}
            <Field label={MODERATION_COPY.endsOptional}>
                {(control) => <input {...control} type="date" name="until" />}
            </Field>
            <TextField
                name="reason"
                label={MODERATION_COPY.reason}
                hint={MODERATION_COPY.reasonHint}
                required
                maxLength={500}
            />
        </>
    );
}

export function RestrictionsSection({
    outcome,
    products,
}: {
    readonly outcome: Outcome<Listed>;
    readonly products: Products;
}) {
    const navigation = useListNavigation();
    const nameOf = (productId: string) => {
        const found = products.ok ? products.value.find((p) => p.id === productId) : undefined;
        return found === undefined ? productId : productName(found.name);
    };
    return (
        <Section
            caption={MODERATION_COPY.restrictions}
            actions={
                <AccountAction
                    action="moderation:remove"
                    label={MODERATION_COPY.restrict}
                    title={MODERATION_COPY.restrictTitle}
                    icon="ban"
                    tone="danger"
                    fields={<RestrictForm products={products} />}
                    run={(form) => {
                        const product = String(form.get("product") ?? "").trim();
                        return restrictAccount({
                            data: {
                                username: String(form.get("username") ?? "").trim(),
                                kind: form.get("kind") === "barred" ? "barred" : "muted",
                                productId: isProductId(product) ? product : null,
                                reason: String(form.get("reason") ?? "").trim(),
                                endsAt: untilFrom(form.get("until")),
                            },
                        });
                    }}
                />
            }
        >
            {!outcome.ok ? (
                <ListRefusal refused={outcome.refused} />
            ) : outcome.value.items.length === 0 ? (
                <Empty>{MODERATION_COPY.noRestrictions}</Empty>
            ) : (
                <Stack gap={4}>
                    <Table
                        caption={MODERATION_COPY.table}
                        rows={outcome.value.items}
                        rowKey={(row) => row.id}
                        columns={[
                            {
                                key: "account",
                                header: MODERATION_COPY.account,
                                cell: (row) => (
                                    <Who
                                        accountId={row.accountId}
                                        username={row.username}
                                        pending={ADMIN_COPY.pending}
                                    />
                                ),
                            },
                            {
                                key: "kind",
                                header: MODERATION_COPY.kind,
                                cell: (row) => MODERATION_COPY[row.kind],
                            },
                            {
                                key: "scope",
                                header: MODERATION_COPY.scope,
                                cell: (row) =>
                                    row.productId === null
                                        ? MODERATION_COPY.everywhere
                                        : nameOf(row.productId),
                            },
                            {
                                key: "reason",
                                header: MODERATION_COPY.reason,
                                cell: (row) => row.reason,
                            },
                            {
                                key: "ends",
                                header: MODERATION_COPY.ends,
                                cell: (row) =>
                                    row.endsAt === null ? (
                                        MODERATION_COPY.untilLifted
                                    ) : (
                                        <Time at={row.endsAt} />
                                    ),
                            },
                            {
                                key: "lift",
                                header: "",
                                cell: (row) => (
                                    <AccountAction
                                        action="moderation:remove"
                                        label={MODERATION_COPY.lift}
                                        title={MODERATION_COPY.liftTitle(
                                            row.username ?? row.accountId,
                                        )}
                                        icon="rotate-ccw"
                                        fields={<p>{MODERATION_COPY.liftBody}</p>}
                                        run={() => liftRestriction({ data: { id: row.id } })}
                                    />
                                ),
                            },
                        ]}
                    />
                    <Pager
                        nextCursor={outcome.value.nextCursor}
                        onNext={(cursor) => void navigation.next(cursor)}
                    />
                </Stack>
            )}
        </Section>
    );
}
