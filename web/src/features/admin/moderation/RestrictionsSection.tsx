import { ProductId } from "@lucent/core/scalars";
import type { Outcome } from "../../../server/outcome.ts";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Field } from "../../../ui/Field/Field.tsx";
import { Pager } from "../../../ui/Pager/Pager.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { untilFrom } from "../accounts/until.ts";
import { ADMIN_COPY } from "../copy.ts";
import { ListRefusal } from "../ListRefusal.tsx";
import { useListNavigation } from "../list.ts";
import { MODERATION_COPY } from "./copy.ts";
import styles from "./ModerationPage.module.css";
import type { listRestrictions } from "./server.ts";
import { liftRestriction, restrictAccount } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof listRestrictions>>, { ok: true }>["value"];

function RestrictForm() {
    return (
        <>
            <TextField name="username" label={MODERATION_COPY.username} required maxLength={64} />
            <label className={styles.select}>
                <span className={styles.label}>{MODERATION_COPY.kind}</span>
                <select name="kind" required className={styles.control}>
                    <option value="muted">{MODERATION_COPY.muted}</option>
                    <option value="barred">{MODERATION_COPY.barred}</option>
                </select>
            </label>
            <TextField
                name="product"
                label={MODERATION_COPY.product}
                hint={MODERATION_COPY.productHint}
                maxLength={32}
                customCheck={(value) =>
                    value.trim() === "" || ProductId.safeParse(value.trim()).success
                        ? undefined
                        : MODERATION_COPY.productFormat
                }
            />
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

export function RestrictionsSection({ outcome }: { readonly outcome: Outcome<Listed> }) {
    const navigation = useListNavigation();
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
                    fields={<RestrictForm />}
                    run={(form) => {
                        const product = String(form.get("product") ?? "").trim();
                        return restrictAccount({
                            data: {
                                username: String(form.get("username") ?? "").trim(),
                                kind: form.get("kind") === "barred" ? "barred" : "muted",
                                productId: product === "" ? null : ProductId.parse(product),
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
                                cell: (row) => row.productId ?? MODERATION_COPY.everywhere,
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
