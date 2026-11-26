import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Named } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Select } from "../../ui/Select/Select.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { postingNote } from "../comments/posting.ts";
import { TextArea } from "../comments/TextArea.tsx";
import { fetchGuides, publishGuide } from "../guides/server.ts";
import { productName } from "../products/view.ts";
import { COMMUNITY_COPY as C } from "./copy.ts";
import styles from "./GuidesPage.module.css";
import { CommunityTabs } from "./Tabs.tsx";

type Listed = Extract<Awaited<ReturnType<typeof fetchGuides>>, { readonly ok: true }>["value"];
type Guide = Listed["items"][number];

export type GuidesData = {
    readonly products: readonly {
        readonly productId: string;
        readonly name: string;
        readonly guides: Outcome<Listed>;
    }[];
};

function GuideRow({ guide }: { readonly guide: Guide }) {
    return (
        <div className={styles.guide}>
            <Link to="/guides/$guideId" params={{ guideId: guide.id }} className={styles.title}>
                {guide.title}
            </Link>
            <span className={styles.author}>
                <Named avatar={guide.author.avatar}>
                    {guide.author.username ?? C.unknownAuthor}
                </Named>
            </span>
            <span className={styles.updated}>
                <Time at={guide.updatedAt} format="date" />
            </span>
        </div>
    );
}

// One product's guides, the first page from the loader and "more" appending the next
// client-side.
function ProductGuides({
    productId,
    name,
    first,
}: {
    readonly productId: string;
    readonly name: string;
    readonly first: Outcome<Listed>;
}) {
    const [guides, setGuides] = useState<readonly Guide[]>(first.ok ? first.value.items : []);
    const [next, setNext] = useState<string | null>(first.ok ? first.value.nextCursor : null);
    const [pending, setPending] = useState(false);
    return (
        <Section caption={productName(name)}>
            {first.ok ? null : <RefusalNote refused={first.refused} />}
            {guides.length === 0 ? (
                first.ok ? (
                    <Empty>{C.noGuides}</Empty>
                ) : null
            ) : (
                <div className={styles.list}>
                    {guides.map((guide) => (
                        <GuideRow key={guide.id} guide={guide} />
                    ))}
                </div>
            )}
            {next === null ? null : (
                <div>
                    <Button
                        type="button"
                        tone="plain"
                        pending={pending}
                        onClick={async () => {
                            setPending(true);
                            const more = await fetchGuides({ data: { productId, cursor: next } });
                            setPending(false);
                            if (!more.ok) return;
                            setGuides((soFar) => [...soFar, ...more.value.items]);
                            setNext(more.value.nextCursor);
                        }}
                    >
                        {C.more}
                    </Button>
                </div>
            )}
        </Section>
    );
}

function WriteGuide({ products }: { readonly products: GuidesData["products"] }) {
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const publish = async (form: FormData) => {
        const reply = await publishGuide({
            data: {
                productId: String(form.get("productId") ?? ""),
                title: String(form.get("title") ?? ""),
                body: String(form.get("body") ?? ""),
            },
        });
        if (!reply.ok) return setRefused(reply.refused);
        setRefused(null);
        await router.navigate({ to: "/guides/$guideId", params: { guideId: reply.value.id } });
    };
    const note = postingNote(refused);
    return (
        <Section caption={C.writeGuide}>
            <form action={publish}>
                <Stack gap={3}>
                    <RefusalNote
                        refused={refused}
                        {...(note === undefined ? {} : { extra: note })}
                    />
                    <Select
                        name="productId"
                        label={C.product}
                        required
                        options={products.map((p) => ({
                            value: p.productId,
                            label: productName(p.name),
                        }))}
                    />
                    <TextField name="title" label={C.titleField} required maxLength={120} />
                    <TextArea name="body" label={C.bodyField} maxLength={20000} required />
                    <div>
                        <Button type="submit">{C.publish}</Button>
                    </div>
                </Stack>
            </form>
        </Section>
    );
}

// The community's guides, product by product, and the form that writes one. The same head row as
// the members: the tabs name the page.
export function GuidesPage({ data }: { readonly data: GuidesData }) {
    return (
        <Page title={C.title} hideTitle tabs={<CommunityTabs />}>
            <Stack gap={6}>
                {data.products.map((product) => (
                    <ProductGuides
                        key={product.productId}
                        productId={product.productId}
                        name={product.name}
                        first={product.guides}
                    />
                ))}
                {data.products.length === 0 ? null : <WriteGuide products={data.products} />}
            </Stack>
        </Page>
    );
}
