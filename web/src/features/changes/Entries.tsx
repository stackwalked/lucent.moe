import type { ReactNode } from "react";
import { useState } from "react";
import type { Outcome } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { CHANGES_COPY as C } from "./copy.ts";
import styles from "./Entries.module.css";
import { fetchChangelog } from "./server.ts";

type Page = Extract<Awaited<ReturnType<typeof fetchChangelog>>, { readonly ok: true }>["value"];
export type Entry = Page["entries"][number];

function Lines({
    caption,
    lines,
}: {
    readonly caption: string;
    readonly lines: readonly string[];
}) {
    if (lines.length === 0) return null;
    return (
        <div className={styles.lines}>
            <h4 className={styles.linesCaption}>{caption}</h4>
            <ul className={styles.list}>
                {lines.map((line) => (
                    <li key={line}>{line}</li>
                ))}
            </ul>
        </div>
    );
}

// A changelog entry as the record writes it: the version or title in ink in the gutter with the
// date under it (and, where a page lists more than one subject, what the entry is about in small
// ink-2 above); the added/changed/fixed lines, then the title when both exist, then the body.
// The id is the entry's own, so another page can link straight to it.
export function EntryRow({
    entry,
    subject,
}: {
    readonly entry: Entry;
    // What the entry is about ("counter-strike 2", "loader", "lucent"), or null on a page that
    // is one subject throughout.
    readonly subject: ReactNode;
}) {
    const head = entry.version ?? entry.title;
    return (
        <article className={styles.entry} id={entry.id}>
            <div className={styles.gutter}>
                {subject === null ? null : <p className={styles.subject}>{subject}</p>}
                {head === null ? null : <h3 className={styles.head}>{head}</h3>}
                <p className={styles.date}>
                    <Time at={entry.publishedAt} format="date" />
                </p>
            </div>
            <div className={styles.content}>
                <Lines caption={C.added} lines={entry.added} />
                <Lines caption={C.changed} lines={entry.changed} />
                <Lines caption={C.fixed} lines={entry.fixed} />
                {entry.version !== null && entry.title !== null ? (
                    <p className={styles.entryTitle}>{entry.title}</p>
                ) : null}
                {entry.body === "" ? null : <p className={styles.body}>{entry.body}</p>}
            </div>
        </article>
    );
}

// The first page comes with the loader; "more" appends the next one, client-side, keeping the
// address as it is.
export function Entries({
    first,
    filter,
    subjectOf,
}: {
    readonly first: Outcome<Page>;
    readonly filter: {
        readonly productId?: string | null;
        readonly subject?: "product" | "loader" | "service";
    };
    readonly subjectOf: (entry: Entry) => ReactNode;
}) {
    const [pages, setPages] = useState<readonly (readonly Entry[])[]>(
        first.ok ? [first.value.entries] : [],
    );
    const [next, setNext] = useState<string | null>(first.ok ? first.value.next : null);
    const [pending, setPending] = useState(false);
    const entries = pages.flat();
    return (
        <>
            {entries.length === 0 ? (
                <Empty>{C.none}</Empty>
            ) : (
                <div className={styles.entries}>
                    {entries.map((entry) => (
                        <EntryRow key={entry.id} entry={entry} subject={subjectOf(entry)} />
                    ))}
                </div>
            )}
            {next === null ? null : (
                <div className={styles.moreRow}>
                    <Button
                        type="button"
                        tone="plain"
                        pending={pending}
                        onClick={async () => {
                            if (next === null) return;
                            setPending(true);
                            const more = await fetchChangelog({
                                data: { ...filter, cursor: next },
                            });
                            setPending(false);
                            if (!more.ok) return;
                            setPages((soFar) => [...soFar, more.value.entries]);
                            setNext(more.value.next);
                        }}
                    >
                        {C.more}
                    </Button>
                </div>
            )}
        </>
    );
}
