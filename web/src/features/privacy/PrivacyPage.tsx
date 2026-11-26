import { getRouteApi, Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Select } from "../../ui/Select/Select.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Switch } from "../../ui/Switch/Switch.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { memberOf } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PRIVACY_COPY } from "./copy.ts";
import { DeletionSection } from "./DeletionSection.tsx";
import { blockAccount, fetchExport, saveShows, saveVisibility } from "./server.ts";
import { PRIVACY_TITLE } from "./title.ts";

const route = getRouteApi("/_member/account/privacy");

type Answer = { readonly ok: true } | { readonly ok: false; readonly refused: Refused };

// The export is one JSON file made in the browser from what platform returned, so the data
// never passes through a link that could be shared.
async function download(): Promise<Refused | null> {
    const reply = await fetchExport();
    if (!reply.ok) return reply.refused;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(reply.value, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = PRIVACY_COPY.exportName;
    link.click();
    URL.revokeObjectURL(url);
    return null;
}

export function PrivacyPage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const [refused, setRefused] = useState<Refused | null>(null);
    const answer = async (reply: Answer) => {
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    return (
        <Page
            title={PRIVACY_TITLE}
            width="narrow"
            actions={
                viewer?.username == null ? null : (
                    <Link to="/members/$username" params={{ username: viewer.username }}>
                        {PRIVACY_COPY.yourProfile}
                    </Link>
                )
            }
        >
            <RefusalNote refused={outcome.ok ? refused : outcome.refused} />
            {outcome.ok ? (
                <Stack gap={6}>
                    <Section caption={PRIVACY_COPY.standing}>
                        {outcome.value.restrictions.length === 0 ? (
                            <Empty>{PRIVACY_COPY.clear}</Empty>
                        ) : (
                            <Table
                                caption={PRIVACY_COPY.restricted}
                                rows={outcome.value.restrictions}
                                rowKey={(row) => row.id}
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
                    <Section caption={PRIVACY_COPY.visibility}>
                        <form
                            key={outcome.value.visibility}
                            action={async (form) =>
                                answer(
                                    await saveVisibility({
                                        data: {
                                            visibility:
                                                form.get("visibility") === "private"
                                                    ? "private"
                                                    : "members",
                                        },
                                    }),
                                )
                            }
                        >
                            <Stack direction="row" gap={3} align="end">
                                <Select
                                    name="visibility"
                                    label={PRIVACY_COPY.visibilityField}
                                    defaultValue={outcome.value.visibility}
                                    options={[
                                        { value: "members", label: PRIVACY_COPY.members },
                                        { value: "private", label: PRIVACY_COPY.private },
                                    ]}
                                />
                                <Button type="submit">{PRIVACY_COPY.save}</Button>
                            </Stack>
                        </form>
                    </Section>
                    <Section caption={PRIVACY_COPY.shownOnProfile}>
                        <Stack gap={2}>
                            {(
                                [
                                    ["invitedBy", PRIVACY_COPY.showInvitedBy],
                                    ["invited", PRIVACY_COPY.showInvited],
                                    ["products", PRIVACY_COPY.showProducts],
                                    ["lastSeen", PRIVACY_COPY.showLastSeen],
                                    ["discord", PRIVACY_COPY.showDiscord],
                                    ["wall", PRIVACY_COPY.showWall],
                                ] as const
                            ).map(([key, label]) => (
                                <Switch
                                    key={`${key}-${String(outcome.value.shows[key])}`}
                                    name={key}
                                    label={label}
                                    defaultChecked={outcome.value.shows[key]}
                                    onChange={async (shown) => {
                                        void answer(await saveShows({ data: { key, shown } }));
                                    }}
                                />
                            ))}
                        </Stack>
                    </Section>
                    <Section caption={PRIVACY_COPY.blocks}>
                        <Stack gap={4}>
                            <p>{PRIVACY_COPY.blocksHint}</p>
                            {outcome.value.blocks.length === 0 ? (
                                <Empty>{PRIVACY_COPY.noBlocks}</Empty>
                            ) : (
                                <Table
                                    caption={PRIVACY_COPY.blocksTable}
                                    rows={outcome.value.blocks}
                                    rowKey={(row) => row.username ?? String(row.createdAt)}
                                    columns={[
                                        {
                                            key: "account",
                                            header: PRIVACY_COPY.account,
                                            cell: (row) => row.username,
                                        },
                                        {
                                            key: "since",
                                            header: PRIVACY_COPY.since,
                                            cell: (row) => <Time at={row.createdAt} />,
                                        },
                                        {
                                            key: "unblock",
                                            header: "",
                                            cell: (row) =>
                                                row.username === null ? null : (
                                                    <Button
                                                        size="sm"
                                                        onClick={async () =>
                                                            answer(
                                                                await blockAccount({
                                                                    data: {
                                                                        username:
                                                                            row.username ?? "",
                                                                        blocked: false,
                                                                    },
                                                                }),
                                                            )
                                                        }
                                                    >
                                                        {PRIVACY_COPY.unblock}
                                                    </Button>
                                                ),
                                        },
                                    ]}
                                />
                            )}
                            <form
                                action={async (form) =>
                                    answer(
                                        await blockAccount({
                                            data: {
                                                username: String(form.get("username") ?? ""),
                                                blocked: true,
                                            },
                                        }),
                                    )
                                }
                            >
                                <Stack direction="row" gap={3} align="end">
                                    <TextField
                                        name="username"
                                        label={PRIVACY_COPY.blockField}
                                        required
                                        maxLength={64}
                                    />
                                    <Button type="submit">{PRIVACY_COPY.block}</Button>
                                </Stack>
                            </form>
                        </Stack>
                    </Section>
                    <Section caption={PRIVACY_COPY.data}>
                        <Stack gap={3}>
                            <p>{PRIVACY_COPY.dataBody}</p>
                            <div>
                                <Button onClick={async () => setRefused(await download())}>
                                    {PRIVACY_COPY.download}
                                </Button>
                            </div>
                        </Stack>
                    </Section>
                    <DeletionSection status={outcome.value.deletion} purpose="member" />
                </Stack>
            ) : null}
        </Page>
    );
}
