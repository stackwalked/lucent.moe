import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Named } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Pager } from "../../ui/Pager/Pager.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { postingNote } from "../comments/posting.ts";
import { TextArea } from "../comments/TextArea.tsx";
import { GUIDES_COPY } from "./copy.ts";
import type { fetchGuides } from "./server.ts";
import { publishGuide } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof fetchGuides>>, { ok: true }>["value"];

// A product's guides, on its page: the list, and a form to write one.
export function GuidesSection({
    productId,
    outcome,
}: {
    readonly productId: string;
    readonly outcome: Outcome<Listed>;
}) {
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const publish = async (form: FormData) => {
        const reply = await publishGuide({
            data: {
                productId,
                title: String(form.get("title") ?? ""),
                body: String(form.get("body") ?? ""),
            },
        });
        if (!reply.ok) return setRefused(reply.refused);
        setRefused(null);
        await router.navigate({ to: "/guides/$guideId", params: { guideId: reply.value.id } });
    };
    const shown = outcome.ok ? refused : outcome.refused;
    const note = postingNote(shown);
    return (
        <Section caption={GUIDES_COPY.forProduct}>
            <Stack gap={4}>
                <RefusalNote refused={shown} {...(note === undefined ? {} : { extra: note })} />
                {outcome.ok ? (
                    <>
                        {outcome.value.items.length === 0 ? (
                            <Empty>{GUIDES_COPY.none}</Empty>
                        ) : (
                            <>
                                <Table
                                    caption={GUIDES_COPY.table}
                                    rows={outcome.value.items}
                                    rowKey={(row) => row.id}
                                    columns={[
                                        {
                                            key: "title",
                                            header: GUIDES_COPY.guide,
                                            cell: (row) => (
                                                <Link
                                                    to="/guides/$guideId"
                                                    params={{ guideId: row.id }}
                                                >
                                                    {row.title}
                                                </Link>
                                            ),
                                        },
                                        {
                                            key: "author",
                                            header: GUIDES_COPY.author,
                                            cell: (row) => (
                                                <Named avatar={row.author.avatar}>
                                                    {row.author.username ?? "—"}
                                                </Named>
                                            ),
                                        },
                                        {
                                            key: "updated",
                                            header: GUIDES_COPY.updated,
                                            cell: (row) => (
                                                <Time at={row.updatedAt} format="relative" />
                                            ),
                                        },
                                    ]}
                                />
                                <Pager
                                    nextCursor={outcome.value.nextCursor}
                                    onNext={(cursor) =>
                                        void router.navigate({
                                            to: "/products/$productId",
                                            params: { productId },
                                            search: { cursor },
                                        })
                                    }
                                />
                            </>
                        )}
                        <form action={publish}>
                            <Stack gap={3}>
                                <TextField
                                    name="title"
                                    label={GUIDES_COPY.titleField}
                                    required
                                    maxLength={120}
                                />
                                <TextArea
                                    name="body"
                                    label={GUIDES_COPY.bodyField}
                                    maxLength={20000}
                                    required
                                />
                                <div>
                                    <Button type="submit">{GUIDES_COPY.publish}</Button>
                                </div>
                            </Stack>
                        </form>
                    </>
                ) : null}
            </Stack>
        </Section>
    );
}
