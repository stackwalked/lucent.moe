import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Named } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Code } from "../../ui/Code/Code.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { ReportButton } from "../comments/ReportButton.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { noteLastProduct } from "../products/lastProduct.ts";
import { ProductLead } from "../products/ProductLead.tsx";
import { CLOUD_COPY as C, sizeWords } from "./copy.ts";
import styles from "./ListingPage.module.css";
import { addListing, deleteItem, saveListing, unlistItem } from "./server.ts";

const route = getRouteApi("/_member/products/$productId/cloud_/$listingId");

// More lines than this and the contents start capped, with "show all".
const CAPPED_LINES = 20;

type Listing = Extract<ReturnType<typeof route.useLoaderData>, { readonly ok: true }>["value"];

// What the member is about to install, as text: capped to a height with the rest a click away, or
// "not shown" with its size when the site cannot show the bytes.
function Contents({ listing }: { readonly listing: Listing }) {
    const [all, setAll] = useState(false);
    const { content } = listing;
    if (content === null) {
        return (
            <p className={styles.quiet}>
                {C.notShown} · {sizeWords(listing.size)}
            </p>
        );
    }
    if (content === "") return <p className={styles.quiet}>{C.empty}</p>;
    const long = content.split("\n").length > CAPPED_LINES;
    return (
        <Stack gap={3}>
            {listing.escaped ? <p className={styles.escaped}>{C.escaped}</p> : null}
            <div className={long && !all ? styles.capped : undefined}>
                <Code>{content}</Code>
            </div>
            {long && !all ? (
                <div>
                    <Button size="sm" tone="ghost" onClick={() => setAll(true)}>
                        {C.showAll}
                    </Button>
                </div>
            ) : null}
        </Stack>
    );
}

// The owner's summary and description, in a dialog.
function EditListing({ listing }: { readonly listing: Listing }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    const form = `edit-${listing.id}`;
    const close = () => {
        setOpen(false);
        setRefused(null);
    };
    return (
        <>
            <Button onClick={() => setOpen(true)}>{C.edit}</Button>
            <Dialog
                open={open}
                onClose={close}
                title={C.edit}
                busy={pending}
                actions={
                    <>
                        <Button tone="ghost" disabled={pending} onClick={close}>
                            {C.cancel}
                        </Button>
                        <Button type="submit" form={form} pending={pending}>
                            {C.save}
                        </Button>
                    </>
                }
            >
                <form
                    id={form}
                    action={async (data) => {
                        setPending(true);
                        const reply = await saveListing({
                            data: {
                                listingId: listing.id,
                                summary: String(data.get("summary") ?? ""),
                                description: String(data.get("description") ?? ""),
                            },
                        });
                        setPending(false);
                        setRefused(reply.ok ? null : reply.refused);
                        if (!reply.ok) return;
                        close();
                        await router.invalidate();
                    }}
                >
                    <Stack gap={4}>
                        <TextField
                            name="summary"
                            label={C.summary}
                            maxLength={140}
                            defaultValue={listing.summary}
                        />
                        <TextArea
                            name="description"
                            label={C.description}
                            maxLength={2000}
                            defaultValue={listing.description}
                        />
                        <RefusalNote refused={refused} />
                    </Stack>
                </form>
            </Dialog>
        </>
    );
}

// The one place to add a listing to your cloud; and, for its owner, to edit or unlist it.
function Actions({ listing }: { readonly listing: Listing }) {
    const router = useRouter();
    const [pending, setPending] = useState<"add" | "remove" | "unlist" | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const act = async (
        which: "add" | "remove" | "unlist",
        run: () => Promise<
            { readonly ok: true } | { readonly ok: false; readonly refused: Refused }
        >,
        after: () => Promise<void>,
    ) => {
        setPending(which);
        const reply = await run();
        setPending(null);
        if (reply.ok) {
            setRefused(null);
            return await after();
        }
        // Held already (another tab): the page only needs to say so.
        if (reply.refused.code === "ALREADY_ADDED") return await router.invalidate();
        setRefused(reply.refused);
    };
    return (
        <Stack gap={3}>
            <Stack direction="row" gap={3} align="center">
                {listing.mine ? (
                    <>
                        <EditListing listing={listing} />
                        <Button
                            tone="danger"
                            pending={pending === "unlist"}
                            onClick={() =>
                                void act(
                                    "unlist",
                                    () => unlistItem({ data: { listingId: listing.id } }),
                                    () =>
                                        router.navigate({
                                            to: "/products/$productId/cloud",
                                            params: { productId: listing.productId },
                                        }),
                                )
                            }
                        >
                            {C.unlist}
                        </Button>
                    </>
                ) : listing.copy === null ? (
                    <>
                        <Button
                            tone="pink"
                            pending={pending === "add"}
                            onClick={() =>
                                void act(
                                    "add",
                                    () => addListing({ data: { listingId: listing.id } }),
                                    () => router.invalidate(),
                                )
                            }
                        >
                            {C.add}
                        </Button>
                        <ReportButton kind="listing" targetId={listing.id} />
                    </>
                ) : (
                    <>
                        <span className={styles.added}>{C.added}</span>
                        <Button
                            tone="ghost"
                            pending={pending === "remove"}
                            onClick={() => {
                                const copy = listing.copy;
                                if (copy === null) return;
                                void act(
                                    "remove",
                                    () =>
                                        deleteItem({
                                            data: {
                                                productId: listing.productId,
                                                itemId: copy.itemId,
                                            },
                                        }),
                                    () => router.invalidate(),
                                );
                            }}
                        >
                            {C.remove}
                        </Button>
                        <ReportButton kind="listing" targetId={listing.id} />
                    </>
                )}
            </Stack>
            <RefusalNote refused={refused} />
        </Stack>
    );
}

// One listing, under its product's head row: what it is and its contents on the left, who offers
// it and what to do with it on the right. Adding happens here and nowhere else.
export function ListingPage() {
    const loaded = route.useLoaderData();
    const productId = loaded.ok ? loaded.value.productId : null;
    useEffect(() => {
        if (productId !== null) void noteLastProduct(productId);
    }, [productId]);
    if (!loaded.ok) return null;
    const listing = loaded.value;
    return (
        <Page title={null} hideTitle width="wide">
            <Columns
                head={{ lead: <ProductLead at="cloud" /> }}
                main={
                    <Stack gap={5}>
                        <h2 className={styles.name}>
                            {listing.name} <span className={styles.kind}>{listing.kind}</span>
                        </h2>
                        {listing.summary === "" ? null : (
                            <p className={styles.summary}>{listing.summary}</p>
                        )}
                        {listing.description === "" ? null : (
                            <p className={styles.description}>{listing.description}</p>
                        )}
                        <Section caption={C.contents}>
                            <Contents listing={listing} />
                        </Section>
                    </Stack>
                }
                aside={
                    <Stack gap={6}>
                        <Section caption={C.listing}>
                            <Pairs
                                align="end"
                                items={[
                                    {
                                        label: C.owner,
                                        value:
                                            listing.owner.username === null ? (
                                                C.unknownOwner
                                            ) : (
                                                <Named avatar={listing.owner.avatar}>
                                                    <Link
                                                        to="/members/$username"
                                                        params={{
                                                            username: listing.owner.username,
                                                        }}
                                                    >
                                                        {listing.owner.username}
                                                    </Link>
                                                </Named>
                                            ),
                                    },
                                    {
                                        label: C.listed,
                                        value: <Time at={listing.listedAt} format="date" />,
                                    },
                                    {
                                        label: C.updated,
                                        value: <Time at={listing.updatedAt} format="date" />,
                                    },
                                    { label: C.size, value: sizeWords(listing.size) },
                                ]}
                            />
                        </Section>
                        <Actions listing={listing} />
                    </Stack>
                }
            />
        </Page>
    );
}
