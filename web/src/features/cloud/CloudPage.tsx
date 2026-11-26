import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Copy } from "../../ui/Copy/Copy.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { CloudView } from "./CloudView.tsx";
import { CLOUD_COPY as C } from "./copy.ts";
import type { fetchHistory } from "./server.ts";
import { createShare, deleteItem, renameItem, restoreItem, revokeShare } from "./server.ts";

const route = getRouteApi("/_member/cloud");
type Detail = {
    readonly productId: string;
    readonly itemId: string;
    readonly canAppend: boolean;
    readonly canShare: boolean;
    readonly history: Extract<Awaited<ReturnType<typeof fetchHistory>>, { ok: true }>["value"];
};

function History({ detail }: { readonly detail: Detail }) {
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const [busy, setBusy] = useState(false);
    const [link, setLink] = useState<{ url: string; id: string } | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [notice, setNotice] = useState("");
    const { productId, itemId, history, canAppend, canShare } = detail;
    const current = history.versions[0];
    if (!current) return null;
    const data = { productId, itemId };
    const base = current.revision;
    async function act<T>(
        operation: () => Promise<Outcome<T>>,
        after?: (value: T) => void | Promise<void>,
    ) {
        setBusy(true);
        setRefused(null);
        setNotice("");
        const reply = await operation();
        if (reply.ok) {
            await after?.(reply.value);
            await router.invalidate();
        } else setRefused(reply.refused);
        setBusy(false);
    }
    const changed = (value: { readonly conflict: boolean }) => {
        if (value.conflict) setNotice(C.conflict);
    };
    return (
        <Page
            title={current.name}
            width="narrow"
            trail={
                <Link to="/cloud" search={{ product: productId }}>
                    {C.title}
                </Link>
            }
        >
            <RefusalNote refused={refused} />
            <p role="status">{notice}</p>
            {canAppend ? (
                <form
                    action={async (form) => {
                        const name = String(form.get("name") ?? "").trim();
                        if (name)
                            await act(() => renameItem({ data: { ...data, name, base } }), changed);
                    }}
                >
                    <TextField
                        key={base}
                        label={C.name}
                        name="name"
                        defaultValue={current.name}
                        required
                        maxLength={64}
                    />
                    <Button type="submit" disabled={busy}>
                        {C.rename}
                    </Button>
                </form>
            ) : (
                <p>{C.paused}</p>
            )}
            <Section caption={C.history}>
                <ul>
                    {history.versions.map((v) => (
                        <li key={v.revision}>
                            {C.revision(v.revision)} · {v.name}{" "}
                            {canAppend && v.revision !== base && (
                                <Button
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                        void act(
                                            () =>
                                                restoreItem({
                                                    data: { ...data, revision: v.revision, base },
                                                }),
                                            changed,
                                        )
                                    }
                                >
                                    {C.restore}
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            </Section>
            <Section caption={C.links}>
                <Stack gap={2}>
                    {canShare && (
                        <Button
                            disabled={busy}
                            onClick={() =>
                                void act(
                                    () => createShare({ data }),
                                    (s) =>
                                        setLink({
                                            url: `${window.location.origin}/share#${productId}/${s.token}`,
                                            id: s.shareId,
                                        }),
                                )
                            }
                        >
                            {C.shareLink}
                        </Button>
                    )}
                    {link && history.shares.some((s) => s.shareId === link.id) && (
                        <Stack direction="row" gap={2}>
                            <label>
                                {C.copy}
                                <input
                                    readOnly
                                    value={link.url}
                                    onFocus={(e) => e.currentTarget.select()}
                                />
                            </label>
                            <Copy value={link.url} />
                        </Stack>
                    )}
                    {history.shares.length === 0 ? (
                        <p>{C.noLinks}</p>
                    ) : (
                        <ul>
                            {history.shares.map((s) => (
                                <li key={s.shareId}>
                                    {C.revision(s.revision)} · {s.shareId}{" "}
                                    <Button
                                        size="sm"
                                        disabled={busy}
                                        onClick={() =>
                                            void act(
                                                () =>
                                                    revokeShare({
                                                        data: { productId, shareId: s.shareId },
                                                    }),
                                                () => setLink(null),
                                            )
                                        }
                                    >
                                        {C.revoke}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Stack>
            </Section>
            <Button tone="danger" onClick={() => setDeleting(true)} disabled={busy}>
                {C.delete}
            </Button>
            <Dialog
                title={C.confirmDelete}
                open={deleting}
                busy={busy}
                onClose={() => setDeleting(false)}
                actions={
                    <>
                        <Button onClick={() => setDeleting(false)} disabled={busy}>
                            {C.cancel}
                        </Button>
                        <Button
                            tone="danger"
                            pending={busy}
                            onClick={() =>
                                void act(
                                    () => deleteItem({ data }),
                                    async () => {
                                        setDeleting(false);
                                        await router.navigate({
                                            to: "/cloud",
                                            search: { product: productId },
                                        });
                                    },
                                )
                            }
                        >
                            {C.delete}
                        </Button>
                    </>
                }
            >
                <RefusalNote refused={refused} />
            </Dialog>
        </Page>
    );
}

export function CloudPage() {
    const loaded = route.useLoaderData();
    if (!loaded.ok)
        return (
            <Page title={C.title}>
                <RefusalNote refused={loaded.refused} />
            </Page>
        );
    if (loaded.view === "history")
        return <History key={`${loaded.productId}/${loaded.itemId}`} detail={loaded} />;
    if (loaded.view === "none")
        return (
            <Page title={C.title}>
                <Empty>{C.emptyProducts}</Empty>
            </Page>
        );
    return (
        <>
            <CloudView />
        </>
    );
}
