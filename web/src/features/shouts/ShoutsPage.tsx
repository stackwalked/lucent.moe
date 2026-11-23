import { ProductId } from "@lucent/core/scalars";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pager } from "../../ui/Pager/Pager.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { postingNote } from "../comments/posting.ts";
import { TextArea } from "../comments/TextArea.tsx";
import { SHOUTS_COPY } from "./copy.ts";
import { postShout } from "./server.ts";
import { SHOUTS_TITLE } from "./title.ts";

const route = getRouteApi("/_member/shouts");

export function ShoutsPage() {
    const outcome = route.useLoaderData();
    const { product } = route.useSearch();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const post = async (form: FormData) => {
        const named = String(form.get("product") ?? "").trim();
        const reply = await postShout({
            data: {
                productId: named === "" ? null : ProductId.parse(named),
                body: String(form.get("body") ?? ""),
            },
        });
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const shown = outcome.ok ? refused : outcome.refused;
    const note = postingNote(shown);
    return (
        <Page
            title={product === undefined ? SHOUTS_TITLE : SHOUTS_COPY.forProduct(product)}
            actions={
                product === undefined ? null : <Link to="/shouts">{SHOUTS_COPY.allShouts}</Link>
            }
        >
            <Stack gap={6}>
                <RefusalNote refused={shown} {...(note === undefined ? {} : { extra: note })} />
                {outcome.ok ? (
                    <>
                        <Section caption={SHOUTS_COPY.post}>
                            <form action={post} key={outcome.value.items[0]?.id ?? ""}>
                                <Stack gap={3}>
                                    <TextArea
                                        name="body"
                                        label={SHOUTS_COPY.body}
                                        maxLength={280}
                                        required
                                    />
                                    <TextField
                                        name="product"
                                        label={SHOUTS_COPY.productField}
                                        hint={SHOUTS_COPY.productHint}
                                        maxLength={32}
                                        defaultValue={product ?? ""}
                                        customCheck={(value) =>
                                            value.trim() === "" ||
                                            ProductId.safeParse(value.trim()).success
                                                ? undefined
                                                : SHOUTS_COPY.productFormat
                                        }
                                    />
                                    <div>
                                        <Button type="submit">{SHOUTS_COPY.post}</Button>
                                    </div>
                                </Stack>
                            </form>
                        </Section>
                        {outcome.value.items.length === 0 ? (
                            <Empty>{SHOUTS_COPY.none}</Empty>
                        ) : (
                            <>
                                <Table
                                    caption={SHOUTS_COPY.table}
                                    rows={outcome.value.items}
                                    rowKey={(row) => row.id}
                                    columns={[
                                        {
                                            key: "author",
                                            header: SHOUTS_COPY.author,
                                            cell: (row) =>
                                                row.isMine ? (
                                                    SHOUTS_COPY.you
                                                ) : row.author.username === null ? (
                                                    "—"
                                                ) : (
                                                    <Link
                                                        to="/members/$username"
                                                        params={{ username: row.author.username }}
                                                    >
                                                        {row.author.username}
                                                    </Link>
                                                ),
                                        },
                                        {
                                            key: "body",
                                            header: SHOUTS_COPY.body,
                                            cell: (row) => row.body,
                                        },
                                        {
                                            key: "about",
                                            header: SHOUTS_COPY.about,
                                            cell: (row) =>
                                                row.productId === null ? null : (
                                                    <Link
                                                        to="/shouts"
                                                        search={{ product: row.productId }}
                                                    >
                                                        {row.productId}
                                                    </Link>
                                                ),
                                        },
                                        {
                                            key: "time",
                                            header: SHOUTS_COPY.time,
                                            cell: (row) => (
                                                <Time at={row.createdAt} format="relative" />
                                            ),
                                        },
                                    ]}
                                />
                                <Pager
                                    nextCursor={outcome.value.nextCursor}
                                    onNext={(cursor) =>
                                        void router.navigate({
                                            to: "/shouts",
                                            search: {
                                                cursor,
                                                ...(product === undefined ? {} : { product }),
                                            },
                                        })
                                    }
                                />
                            </>
                        )}
                    </>
                ) : null}
            </Stack>
        </Page>
    );
}
