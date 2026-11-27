import type { ProductId } from "@lucent/core/scalars";
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { type Closed, useClosedWords } from "../comments/closed.ts";
import { postingNote } from "../comments/posting.ts";
import { ReportButton } from "../comments/ReportButton.tsx";
import { type PurgeTarget, readShoutInput } from "./command.ts";
import { SHOUTS_COPY as C } from "./copy.ts";
import styles from "./ShoutFeed.module.css";
import { fetchShouts, postShout, purgeShouts, removeShout } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof fetchShouts>>, { readonly ok: true }>["value"];
type Shout = Listed["items"][number];

// Where the list should be once the items change: at the bottom (load, a new shout), or where
// it was, with older shouts added above it.
type Scroll = { readonly to: "bottom" } | { readonly to: "keep"; readonly height: number };

function targetWords(target: PurgeTarget): string {
    return "username" in target ? target.username : C.lastShouts(target.last);
}

function Row({
    shout,
    onDelete,
}: {
    readonly shout: Shout;
    readonly onDelete: (id: string) => void;
}) {
    const { author } = shout;
    return (
        <li className={styles.shout}>
            <span className={styles.pic}>
                <Avatar digest={author.avatar} size="small" />
            </span>
            <div className={styles.text}>
                <div className={styles.who}>
                    {author.username === null ? (
                        <span className={styles.name}>{C.unknownAuthor}</span>
                    ) : (
                        <Link
                            to="/members/$username"
                            params={{ username: author.username }}
                            className={styles.name}
                        >
                            {author.username}
                        </Link>
                    )}
                    <span className={styles.acts}>
                        {shout.canDelete ? (
                            <Button size="sm" tone="ghost" onClick={() => onDelete(shout.id)}>
                                {C.delete}
                            </Button>
                        ) : null}
                        {shout.isMine ? null : <ReportButton kind="shout" targetId={shout.id} />}
                    </span>
                    <span className={styles.when}>
                        <Time at={shout.createdAt} format="relative" />
                    </span>
                </div>
                <p className={styles.body}>{shout.body}</p>
            </div>
        </li>
    );
}

// The shout feed: oldest at the top, newest at the bottom with the input under it, scrolled to
// the bottom on load. Older pages load above ("more", keeping the place). `productId` narrows
// it to one product and is what a shout is posted about; none is a site-wide shout. Staff
// (`canPurge`) may type `/purge <username>` or `/purge <n>` in the input, which asks once.
// A bounded height is the feed's own: it fills the viewport under its page's head row.
export function ShoutFeed({
    first,
    productId,
    canPurge,
    closed,
}: {
    readonly first: Outcome<Listed>;
    readonly productId: ProductId | null;
    readonly canPurge: boolean;
    // What closes the viewer's own words, when something does.
    readonly closed: Closed | null;
}) {
    const [items, setItems] = useState<readonly Shout[]>(
        first.ok ? [...first.value.items].reverse() : [],
    );
    const [older, setOlder] = useState<string | null>(first.ok ? first.value.nextCursor : null);
    const [refused, setRefused] = useState<Refused | null>(first.ok ? null : first.refused);
    const [usage, setUsage] = useState(false);
    const [loading, setLoading] = useState(false);
    const [formKey, setFormKey] = useState(0);
    const [purge, setPurge] = useState<PurgeTarget | null>(null);
    const [purging, setPurging] = useState(false);
    const list = useRef<HTMLDivElement>(null);
    const scroll = useRef<Scroll | null>({ to: "bottom" });

    useLayoutEffect(() => {
        const element = list.current;
        const wanted = scroll.current;
        if (element === null || wanted === null) return;
        element.scrollTop =
            wanted.to === "bottom"
                ? element.scrollHeight
                : element.scrollTop + element.scrollHeight - wanted.height;
        scroll.current = null;
    });

    const fresh = async () => await fetchShouts({ data: { productId, cursor: null } });
    // Shouts newer than what the feed holds are added at the bottom.
    const catchUp = async () => {
        const page = await fresh();
        if (!page.ok) return setRefused(page.refused);
        const known = new Set(items.map((shout) => shout.id));
        const added = page.value.items.filter((shout) => !known.has(shout.id)).reverse();
        scroll.current = { to: "bottom" };
        setItems((soFar) => [...soFar, ...added]);
    };
    const reload = async () => {
        const page = await fresh();
        if (!page.ok) return setRefused(page.refused);
        scroll.current = { to: "bottom" };
        setItems([...page.value.items].reverse());
        setOlder(page.value.nextCursor);
    };

    const send = async (form: FormData) => {
        setUsage(false);
        const input = readShoutInput(String(form.get("body") ?? ""), canPurge ? "staff" : "member");
        if (input.kind === "usage") return setUsage(true);
        if (input.kind === "purge") return setPurge(input.target);
        const reply = await postShout({ data: { productId, body: input.body } });
        if (!reply.ok) return setRefused(reply.refused);
        setRefused(null);
        setFormKey((key) => key + 1);
        await catchUp();
    };
    const remove = async (id: string) => {
        const reply = await removeShout({ data: { id } });
        if (!reply.ok) return setRefused(reply.refused);
        setRefused(null);
        setItems((soFar) => soFar.filter((shout) => shout.id !== id));
    };
    const loadOlder = async () => {
        if (older === null) return;
        setLoading(true);
        const page = await fetchShouts({ data: { productId, cursor: older } });
        setLoading(false);
        if (!page.ok) return setRefused(page.refused);
        scroll.current = { to: "keep", height: list.current?.scrollHeight ?? 0 };
        setItems((soFar) => [...[...page.value.items].reverse(), ...soFar]);
        setOlder(page.value.nextCursor);
    };
    const runPurge = async () => {
        if (purge === null) return;
        setPurging(true);
        const reply = await purgeShouts({ data: purge });
        setPurging(false);
        setPurge(null);
        if (!reply.ok) return setRefused(reply.refused);
        setRefused(null);
        setFormKey((key) => key + 1);
        await reload();
    };

    const note = postingNote(refused);
    const closedWords = useClosedWords(closed);
    return (
        <div className={styles.feed}>
            <div className={styles.scroll} ref={list}>
                {older === null ? null : (
                    <div className={styles.moreRow}>
                        <Button type="button" tone="plain" pending={loading} onClick={loadOlder}>
                            {C.more}
                        </Button>
                    </div>
                )}
                {items.length === 0 ? (
                    <Empty>{C.none}</Empty>
                ) : (
                    <ol className={styles.list} aria-label={C.list}>
                        {items.map((shout) => (
                            <Row key={shout.id} shout={shout} onDelete={remove} />
                        ))}
                    </ol>
                )}
            </div>
            <form action={send} key={formKey} className={styles.form}>
                <RefusalNote refused={refused} {...(note === undefined ? {} : { extra: note })} />
                <input
                    className={styles.input}
                    name="body"
                    aria-label={C.body}
                    placeholder={closedWords ?? C.body}
                    maxLength={280}
                    required
                    disabled={closedWords !== null}
                    autoComplete="off"
                />
                {usage ? <p className={styles.usage}>{C.usage}</p> : null}
            </form>
            <Dialog
                open={purge !== null}
                onClose={() => setPurge(null)}
                title={C.purgeTitle(purge === null ? "" : targetWords(purge))}
                busy={purging}
                actions={
                    <>
                        <Button tone="ghost" disabled={purging} onClick={() => setPurge(null)}>
                            {C.cancel}
                        </Button>
                        <Button tone="danger" pending={purging} onClick={runPurge}>
                            {C.purge}
                        </Button>
                    </>
                }
            >
                {null}
            </Dialog>
        </div>
    );
}
