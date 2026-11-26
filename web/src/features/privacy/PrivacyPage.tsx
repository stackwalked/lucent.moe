import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Select } from "../../ui/Select/Select.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { AccountPage, State } from "../account/AccountPage.tsx";
import { Rows } from "../account/Rows.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PRIVACY_COPY } from "./copy.ts";
import { DeletionSection } from "./DeletionSection.tsx";
import { blockAccount, fetchExport, saveVisibility } from "./server.ts";

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
    const [refused, setRefused] = useState<Refused | null>(null);
    const answer = async (reply: Answer) => {
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const main = (
        <>
            <RefusalNote refused={outcome.ok ? refused : outcome.refused} />
            {outcome.ok ? (
                <Stack gap={6}>
                    <Section caption={PRIVACY_COPY.standing}>
                        {outcome.value.restrictions.length === 0 ? (
                            <Empty>{PRIVACY_COPY.clear}</Empty>
                        ) : (
                            <Rows
                                label={PRIVACY_COPY.restricted}
                                items={outcome.value.restrictions.map((row) => ({
                                    key: row.id,
                                    main: PRIVACY_COPY[row.kind],
                                    meta: (
                                        <>
                                            {row.productId === null
                                                ? PRIVACY_COPY.everywhere
                                                : PRIVACY_COPY.inProduct(row.productId)}
                                            {" · "}
                                            {row.endsAt === null ? (
                                                PRIVACY_COPY.untilLifted
                                            ) : (
                                                <>
                                                    {PRIVACY_COPY.until} <Time at={row.endsAt} />
                                                </>
                                            )}
                                        </>
                                    ),
                                }))}
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

                    <Section caption={PRIVACY_COPY.blocks}>
                        <Stack gap={4}>
                            <p>{PRIVACY_COPY.blocksHint}</p>
                            {outcome.value.blocks.length === 0 ? (
                                <Empty>{PRIVACY_COPY.noBlocks}</Empty>
                            ) : (
                                <Rows
                                    label={PRIVACY_COPY.blocksTable}
                                    items={outcome.value.blocks.map((row) => ({
                                        key: row.username ?? String(row.createdAt),
                                        main: row.username,
                                        meta: <Time at={row.createdAt} />,
                                        action:
                                            row.username === null ? undefined : (
                                                <Button
                                                    size="sm"
                                                    onClick={async () =>
                                                        answer(
                                                            await blockAccount({
                                                                data: {
                                                                    username: row.username ?? "",
                                                                    blocked: false,
                                                                },
                                                            }),
                                                        )
                                                    }
                                                >
                                                    {PRIVACY_COPY.unblock}
                                                </Button>
                                            ),
                                    }))}
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
        </>
    );
    return (
        <AccountPage
            main={main}
            aside={
                outcome.ok ? (
                    <State
                        caption={PRIVACY_COPY.title}
                        items={[
                            {
                                label: PRIVACY_COPY.visibilityField,
                                value:
                                    outcome.value.visibility === "private"
                                        ? PRIVACY_COPY.private
                                        : PRIVACY_COPY.members,
                            },
                            {
                                label: PRIVACY_COPY.blockedLabel,
                                value: String(outcome.value.blocks.length),
                            },
                        ]}
                    />
                ) : null
            }
        />
    );
}
