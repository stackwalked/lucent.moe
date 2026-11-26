import type { ReactNode } from "react";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { STATUS_COPY } from "./copy.ts";
import styles from "./Record.module.css";
import type { Snapshot } from "./snapshot.ts";

// What the public record pages share: the line saying the page is from web's snapshot, and an
// issue or changelog entry as text (staff wrote it as plain text; React escapes it).

export function SnapshotPage<T>({
    snapshot,
    children,
}: {
    readonly snapshot: Snapshot<T>;
    readonly children: (value: T) => ReactNode;
}) {
    if (snapshot.state === "unavailable") return <Empty>{STATUS_COPY.unavailable}</Empty>;
    return (
        <>
            {snapshot.state === "stale" ? (
                <p>
                    {STATUS_COPY.asOf} <Time at={snapshot.at} />
                </p>
            ) : null}
            {children(snapshot.value)}
        </>
    );
}

export type Note = {
    readonly id: string;
    readonly title: string;
    readonly body: string;
};

export function Notes<N extends Note>({
    notes,
    meta,
}: {
    readonly notes: readonly N[];
    readonly meta: (note: N) => ReactNode;
}) {
    return (
        <ul className={styles.entries}>
            {notes.map((note) => (
                <li key={note.id} className={styles.entry}>
                    <h3 className={styles.title}>{note.title}</h3>
                    <p className={styles.meta}>{meta(note)}</p>
                    {note.body === "" ? null : <p className={styles.body}>{note.body}</p>}
                </li>
            ))}
        </ul>
    );
}
