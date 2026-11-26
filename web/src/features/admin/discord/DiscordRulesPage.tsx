import { isProductId, isRoleId } from "@lucent/core/brands";
import type { RoleCondition } from "@lucent/rpc/discord/rules";
import { getRouteApi } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Select } from "../../../ui/Select/Select.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { productName } from "../../products/view.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { DISCORD_RULES_COPY as C, DISCORD_RULES_TITLE } from "./copy.ts";
import { addDiscordRule, removeDiscordRule } from "./server.ts";

const route = getRouteApi("/_admin/admin/system/discord");

type Listed = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Rule = Listed["rules"][number];
type Fields = Rule["fields"];
type Condition = RoleCondition;
type Named = { readonly id: string; readonly name: string };

const SNOWFLAKE = "[1-9][0-9]{16,19}";
const FEEDS = ["status", "resources", "releases", "tickets", "review"] as const;
type Feed = (typeof FEEDS)[number];

function feedLabel(feed: Feed): string {
    return C[feed];
}

function textOf(form: FormData, name: string): string {
    return String(form.get(name) ?? "").trim();
}

function IdField({ label }: { readonly label: string }) {
    return (
        <TextField
            name="id"
            label={label}
            hint={C.idHint}
            required
            pattern={SNOWFLAKE}
            inputMode="numeric"
        />
    );
}

function Picker({
    name,
    label,
    options,
}: {
    readonly name: string;
    readonly label: string;
    readonly options: readonly (readonly [string, string])[];
}) {
    return (
        <Select
            name={name}
            label={label}
            options={options.map(([value, text]) => ({ value, label: text }))}
        />
    );
}

function nameOf(products: readonly Named[], productId: string): string {
    const product = products.find((p) => p.id === productId);
    return product === undefined ? productId : productName(product.name);
}

// What a role rule's condition reads as; a product or role since removed shows its id.
function conditionLabel(
    condition: Condition,
    listed: { readonly products: readonly Named[]; readonly roles: readonly Named[] },
): string {
    switch (condition.kind) {
        case "linked":
            return C.linked;
        case "entitled":
            return C.entitled(nameOf(listed.products, condition.productId));
        case "holds_role":
            return C.holds(
                listed.roles.find((r) => r.id === condition.roleId)?.name ?? condition.roleId,
            );
    }
}

function parseCondition(raw: string): Condition | null {
    if (raw === "linked") return { kind: "linked" };
    const [kind, id] = raw.split(":");
    if (kind === "entitled" && isProductId(id)) return { kind: "entitled", productId: id };
    if (kind === "holds_role" && isRoleId(id)) return { kind: "holds_role", roleId: id };
    return null;
}

function idOf(fields: Fields): string {
    return fields.kind === "role" ? fields.roleId : fields.channelId;
}

function Remove({ rule }: { readonly rule: Rule }) {
    return (
        <AccountAction
            action="roles:manage"
            label={C.remove}
            title={C.removeTitle(idOf(rule.fields))}
            tone="danger"
            fields={<p>{C.removeBody}</p>}
            run={() => removeDiscordRule({ data: { ruleId: rule.id } })}
        />
    );
}

function Add({
    label,
    fields,
    toFields,
}: {
    readonly label: string;
    readonly fields: ReactNode;
    readonly toFields: (form: FormData) => Fields | null;
}) {
    return (
        <AccountAction
            action="roles:manage"
            label={label}
            submitLabel={C.add}
            title={label}
            fields={<Stack gap={3}>{fields}</Stack>}
            run={(form) => {
                const parsed = toFields(form);
                return parsed === null
                    ? Promise.resolve({
                          ok: false as const,
                          refused: { code: "INVALID_REQUEST" as const, reference: null },
                      })
                    : addDiscordRule({ data: { fields: parsed } });
            }}
        />
    );
}

// How the Discord bot mirrors the site into the guild: which roles follow which standing, where
// staff lookups may be answered, and which channel gets which feed. Changing it is roles:manage,
// behind its passkey step-up.
export function DiscordRulesPage() {
    const listed = route.useLoaderData();
    if (!listed.ok) {
        return (
            <Page title={DISCORD_RULES_TITLE}>
                <RefusalNote refused={listed.refused} />
            </Page>
        );
    }
    const value = listed.value;
    const roleRules = value.rules.filter((rule) => rule.fields.kind === "role");
    const staffRules = value.rules.filter((rule) => rule.fields.kind === "staff_channel");
    const feedRules = value.rules.filter((rule) => rule.fields.kind === "feed");
    const added = {
        key: "added",
        header: C.added,
        cell: (rule: Rule) => <Time at={rule.createdAt} />,
    };
    const actions = {
        key: "actions",
        header: "",
        align: "end" as const,
        cell: (rule: Rule) => <Remove rule={rule} />,
    };
    const conditions: readonly (readonly [string, string])[] = [
        ["linked", C.linked],
        ...value.products.map(
            (p) => [`entitled:${p.id}`, C.entitled(productName(p.name))] as const,
        ),
        ...value.roles.map((r) => [`holds_role:${r.id}`, C.holds(r.name)] as const),
    ];

    return (
        <Page title={DISCORD_RULES_TITLE}>
            <Stack gap={6}>
                <Section caption={C.roles}>
                    <Stack gap={3}>
                        {roleRules.length === 0 ? (
                            <Empty>{C.noRoles}</Empty>
                        ) : (
                            <Table
                                caption={C.roles}
                                rows={roleRules}
                                rowKey={(rule) => rule.id}
                                columns={[
                                    {
                                        key: "role",
                                        header: C.role,
                                        cell: (rule) => idOf(rule.fields),
                                    },
                                    {
                                        key: "who",
                                        header: C.who,
                                        cell: (rule) =>
                                            rule.fields.kind === "role"
                                                ? conditionLabel(rule.fields.condition, value)
                                                : C.unknown,
                                    },
                                    added,
                                    actions,
                                ]}
                            />
                        )}
                        <div>
                            <Add
                                label={C.addRole}
                                fields={
                                    <>
                                        <IdField label={C.role} />
                                        <Picker
                                            name="condition"
                                            label={C.who}
                                            options={conditions}
                                        />
                                    </>
                                }
                                toFields={(form) => {
                                    const condition = parseCondition(textOf(form, "condition"));
                                    return condition === null
                                        ? null
                                        : { kind: "role", roleId: textOf(form, "id"), condition };
                                }}
                            />
                        </div>
                    </Stack>
                </Section>
                <Section caption={C.staffChannels}>
                    <Stack gap={3}>
                        {staffRules.length === 0 ? (
                            <Empty>{C.noChannels}</Empty>
                        ) : (
                            <Table
                                caption={C.staffChannels}
                                rows={staffRules}
                                rowKey={(rule) => rule.id}
                                columns={[
                                    {
                                        key: "channel",
                                        header: C.channel,
                                        cell: (rule) => idOf(rule.fields),
                                    },
                                    added,
                                    actions,
                                ]}
                            />
                        )}
                        <div>
                            <Add
                                label={C.addChannel}
                                fields={<IdField label={C.channel} />}
                                toFields={(form) => ({
                                    kind: "staff_channel",
                                    channelId: textOf(form, "id"),
                                })}
                            />
                        </div>
                    </Stack>
                </Section>
                <Section caption={C.feeds}>
                    <Stack gap={3}>
                        {feedRules.length === 0 ? (
                            <Empty>{C.noFeeds}</Empty>
                        ) : (
                            <Table
                                caption={C.feeds}
                                rows={feedRules}
                                rowKey={(rule) => rule.id}
                                columns={[
                                    {
                                        key: "channel",
                                        header: C.channel,
                                        cell: (rule) => idOf(rule.fields),
                                    },
                                    {
                                        key: "feed",
                                        header: C.feed,
                                        cell: (rule) =>
                                            rule.fields.kind === "feed"
                                                ? feedLabel(rule.fields.feed)
                                                : C.unknown,
                                    },
                                    added,
                                    actions,
                                ]}
                            />
                        )}
                        <div>
                            <Add
                                label={C.addFeed}
                                fields={
                                    <>
                                        <IdField label={C.channel} />
                                        <Picker
                                            name="feed"
                                            label={C.feed}
                                            options={FEEDS.map((feed) => [feed, feedLabel(feed)])}
                                        />
                                    </>
                                }
                                toFields={(form) => {
                                    const feed = FEEDS.find((f) => f === textOf(form, "feed"));
                                    return feed === undefined
                                        ? null
                                        : { kind: "feed", channelId: textOf(form, "id"), feed };
                                }}
                            />
                        </div>
                    </Stack>
                </Section>
            </Stack>
        </Page>
    );
}
