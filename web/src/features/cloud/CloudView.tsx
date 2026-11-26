import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { IconButton } from "../../ui/IconButton/IconButton.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { ProductPick } from "../../ui/ProductPick/ProductPick.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Tabs } from "../../ui/Tabs/Tabs.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { noteLastProduct } from "../products/lastProduct.ts";
import { productName } from "../products/view.ts";
import { downloadPath } from "../resources/download.ts";
import styles from "./CloudView.module.css";
import { CLOUD_COPY as C } from "./copy.ts";
import { type Listing, ListingRow } from "./ListingRow.tsx";
import { NewItem } from "./NewItem.tsx";
import {
    deleteItem,
    type fetchItems,
    fetchListings,
    type fetchMine,
    importShare,
    listItem,
    unlistItem,
} from "./server.ts";

const route = getRouteApi("/_member/cloud");

type Items = Extract<Awaited<ReturnType<typeof fetchItems>>, { readonly ok: true }>["value"];
type Mine = Extract<Awaited<ReturnType<typeof fetchMine>>, { readonly ok: true }>["value"];
type Kind = "config" | "script" | "inventory";

const SHARE_LINK = /#([a-z0-9][a-z0-9-]{1,31})\/([A-Za-z0-9_-]{43})/;

function Find({ find, product, kind }: { find: string | null; product: string; kind?: Kind }) {
    const router = useRouter();
    const go = (text: string) =>
        router.navigate({
            to: "/cloud",
            search: {
                product,
                ...(kind === undefined ? {} : { kind }),
                ...(text === "" ? {} : { find: text }),
            },
        });
    return (
        <search className={styles.find}>
            <form
                className={styles.findForm}
                key={find ?? ""}
                action={async (form) => go(String(form.get("find") ?? "").trim())}
            >
                <input
                    className={styles.findInput}
                    type="search"
                    name="find"
                    aria-label={C.find}
                    placeholder={C.find}
                    maxLength={64}
                    autoComplete="off"
                    defaultValue={find ?? ""}
                />
                {find === null ? null : (
                    <IconButton icon="x" label={C.clear} size="sm" onClick={() => void go("")} />
                )}
            </form>
        </search>
    );
}

function Listings({
    first,
    productId,
    kind,
    find,
}: {
    first: Outcome<{ items: readonly Listing[]; nextCursor: string | null }>;
    productId: string;
    kind: Kind | undefined;
    find: string | null;
}) {
    const [rows, setRows] = useState<readonly Listing[]>(first.ok ? first.value.items : []);
    const [next, setNext] = useState<string | null>(first.ok ? first.value.nextCursor : null);
    const [pending, setPending] = useState(false);
    if (!first.ok) return <RefusalNote refused={first.refused} />;
    if (rows.length === 0) return <Empty>{C.noListings}</Empty>;
    return (
        <>
            <ul className={styles.list}>
                {rows.map((listing) => (
                    <ListingRow key={listing.id} listing={listing} variant="full" />
                ))}
            </ul>
            {next === null ? null : (
                <div>
                    <Button
                        type="button"
                        pending={pending}
                        onClick={async () => {
                            setPending(true);
                            const more = await fetchListings({
                                data: {
                                    productId,
                                    cursor: next,
                                    ...(kind === undefined ? {} : { kind }),
                                    ...(find === null ? {} : { text: find }),
                                },
                            });
                            setPending(false);
                            if (!more.ok) return;
                            setRows((soFar) => [...soFar, ...more.value.items]);
                            setNext(more.value.nextCursor);
                        }}
                    >
                        {C.more}
                    </Button>
                </div>
            )}
        </>
    );
}

// One of the member's own items: share it (a one-line summary), or once listed its state and
// "unlist"; a copy says whose it was and offers "remove". The name opens the item's history.
function Item({ productId, item, mine }: { productId: string; item: Items[number]; mine: Mine }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    const listing = mine.find((entry) => entry.itemId === item.itemId);
    const settle = async (reply: Outcome<unknown>) => {
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) {
            setOpen(false);
            await router.invalidate();
        }
    };
    return (
        <li className={styles.item}>
            <div className={styles.itemRow}>
                <span className={styles.itemText}>
                    <Link
                        to="/cloud"
                        search={{ product: productId, item: item.itemId }}
                        className={styles.itemName}
                    >
                        {item.name}
                    </Link>
                    <span className={styles.small}>
                        {item.kind} · {item.source === null ? C.yours : C.copyOf(item.source.owner)}
                    </span>
                </span>
                {item.source !== null ? (
                    <Button
                        size="sm"
                        tone="ghost"
                        onClick={async () =>
                            settle(await deleteItem({ data: { productId, itemId: item.itemId } }))
                        }
                    >
                        {C.remove}
                    </Button>
                ) : listing === undefined ? (
                    <Button size="sm" tone="ghost" onClick={() => setOpen(!open)}>
                        {C.shareItem}
                    </Button>
                ) : (
                    <span className={styles.state}>
                        <span data-waiting={listing.state === "pending" || listing.pending}>
                            {listing.state === "pending" || listing.pending ? C.waiting : C.listed}
                        </span>
                        <Button
                            size="sm"
                            tone="ghost"
                            onClick={async () =>
                                settle(await unlistItem({ data: { listingId: listing.id } }))
                            }
                        >
                            {C.unlist}
                        </Button>
                    </span>
                )}
            </div>
            {open ? (
                <form
                    className={styles.shareForm}
                    action={async (form) =>
                        settle(
                            await listItem({
                                data: {
                                    productId,
                                    itemId: item.itemId,
                                    summary: String(form.get("summary") ?? ""),
                                },
                            }),
                        )
                    }
                >
                    <TextField name="summary" label={C.summary} maxLength={140} />
                    <div>
                        <Button type="submit" size="sm">
                            {C.list}
                        </Button>
                    </div>
                </form>
            ) : null}
            <RefusalNote refused={refused} />
        </li>
    );
}

function ImportLink() {
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const [bad, setBad] = useState(false);
    return (
        <form
            className={styles.importForm}
            action={async (form) => {
                const found = SHARE_LINK.exec(String(form.get("link") ?? ""));
                setBad(found === null);
                if (found === null) return;
                const [, productId, token] = found;
                if (productId === undefined || token === undefined) return;
                const reply = await importShare({ data: { productId, token } });
                setRefused(reply.ok ? null : reply.refused);
                if (reply.ok) await router.invalidate();
            }}
        >
            <TextField name="link" label={C.importLink} />
            {bad ? <p className={styles.small}>{C.badLink}</p> : null}
            <RefusalNote refused={refused} />
            <div>
                <Button type="submit" size="sm">
                    {C.importButton}
                </Button>
            </div>
        </form>
    );
}

// /cloud for one product. The main column's head holds the product picker, the kind filters and
// "find"; the aside opens with the member's own cloud, then what staff published.
export function CloudView() {
    const data = route.useLoaderData();
    useEffect(() => {
        if (data.ok && data.view === "items") void noteLastProduct(data.productId);
    }, [data]);
    if (!data.ok || data.view !== "items") return null;
    const { productId, pick, access, kind, find, listings, items, mine, files } = data;
    const current = pick.find((p) => p.productId === productId);
    const kinds: readonly (readonly [Kind | undefined, string])[] = [
        [undefined, C.all],
        ["config", C.configs],
        ["script", C.scripts],
        ["inventory", C.inventories],
    ];
    return (
        <Page title={null} hideTitle>
            <Columns
                head={{
                    lead: (
                        <>
                            <h1 className={styles.title}>
                                <ProductPick
                                    label={productName(current?.name ?? productId)}
                                    current={productId}
                                    rows={pick.map((p) => ({
                                        id: p.productId,
                                        label: productName(p.name),
                                        status: p.held ? null : "no-access",
                                    }))}
                                    linkFor={(id, children) => (
                                        <Link to="/cloud" search={{ product: id }}>
                                            {children}
                                        </Link>
                                    )}
                                />
                            </h1>
                            {access ? (
                                <Tabs
                                    tabs={kinds.map(([value, label]) => ({
                                        to: "/cloud",
                                        search: {
                                            product: productId,
                                            ...(value === undefined ? {} : { kind: value }),
                                            ...(find === null ? {} : { find }),
                                        },
                                        label,
                                        current: value === kind,
                                    }))}
                                />
                            ) : null}
                        </>
                    ),
                    ...(access
                        ? {
                              actions: (
                                  <Find
                                      find={find}
                                      product={productId}
                                      {...(kind === undefined ? {} : { kind })}
                                  />
                              ),
                          }
                        : {}),
                }}
                main={
                    !access || listings === null ? (
                        <Empty>{C.noAccess}</Empty>
                    ) : (
                        <Listings
                            key={`${productId}|${kind ?? ""}|${find ?? ""}|${listings?.ok ? listings.value.items.map((row) => row.id).join() : ""}`}
                            first={listings}
                            productId={productId}
                            kind={kind}
                            find={find}
                        />
                    )
                }
                aside={
                    access && items !== null && mine !== null && files !== null ? (
                        <Stack gap={6}>
                            <Section caption={C.inYourCloud}>
                                {!items.ok ? (
                                    <RefusalNote refused={items.refused} />
                                ) : mine.ok ? (
                                    <ul className={styles.items}>
                                        {items.value.map((item) => (
                                            <Item
                                                key={item.itemId}
                                                productId={productId}
                                                item={item}
                                                mine={mine.value}
                                            />
                                        ))}
                                    </ul>
                                ) : (
                                    <RefusalNote refused={mine.refused} />
                                )}
                                <ImportLink />
                            </Section>
                            {data.canAppend ? (
                                <NewItem key={productId} productId={productId} />
                            ) : null}
                            <Section caption={C.fromStaff}>
                                {!files.ok ? (
                                    <RefusalNote refused={files.refused} />
                                ) : (
                                    (() => {
                                        const shown = files.value.filter(
                                            (file) =>
                                                file.productId === null ||
                                                file.productId === productId,
                                        );
                                        return shown.length === 0 ? (
                                            <Empty>{C.noFiles}</Empty>
                                        ) : (
                                            <ul className={styles.items}>
                                                {shown.map((file) => (
                                                    <li key={file.id} className={styles.itemRow}>
                                                        <span className={styles.itemName}>
                                                            {file.title}
                                                        </span>
                                                        <form
                                                            method="get"
                                                            action={downloadPath(file.id)}
                                                        >
                                                            <Button
                                                                size="sm"
                                                                tone="ghost"
                                                                type="submit"
                                                                label={C.downloadTitle(file.title)}
                                                            >
                                                                {C.download}
                                                            </Button>
                                                        </form>
                                                    </li>
                                                ))}
                                            </ul>
                                        );
                                    })()
                                )}
                            </Section>
                        </Stack>
                    ) : null
                }
            />
        </Page>
    );
}
