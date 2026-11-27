import type { ReactNode } from "react";
import styles from "./SettingRow.module.css";

export type RowActionTone = "ink" | "quiet" | "pink" | "shu";

// A list of SettingRow, divided by hairlines where the rows are settings.
export function SettingRows({
    label,
    children,
}: {
    readonly label: string;
    readonly children: ReactNode;
}) {
    return (
        <ul className={styles.list} aria-label={label}>
            {children}
        </ul>
    );
}

// One line of a settings page: what it is in ink, its value in ink-2, and what to do about it at
// the end. "setting" rows hold their name in a column of its own, so values line up down a
// section; "item" rows (a pc, a sign-in, an invitee) let the value follow the name. A row that
// is only a value has no action.
export function SettingRow({
    name,
    value,
    action,
    layout = "setting",
    nested = false,
    children,
}: {
    readonly name: ReactNode;
    readonly value?: ReactNode;
    readonly action?: ReactNode;
    readonly layout?: "setting" | "item";
    // Belongs to the row above: a passkey under "passkeys".
    readonly nested?: boolean;
    // What the row opens or says beneath itself: its dialog, a refusal.
    readonly children?: ReactNode;
}) {
    return (
        <li className={styles.row} data-layout={layout} data-nested={nested}>
            <span className={styles.name}>{name}</span>
            {value === undefined ? null : <span className={styles.value}>{value}</span>}
            {action === undefined ? null : <span className={styles.action}>{action}</span>}
            {children === undefined ? null : <div className={styles.extra}>{children}</div>}
        </li>
    );
}

// What can be done to a row, as the word for it: a button that reads as an action by its colour
// and its place at the row's end. pink is the one that adds, shu the one that deletes, quiet the
// ones that end or undo.
export function RowAction({
    tone = "ink",
    pending = false,
    label,
    onClick,
    children,
}: {
    readonly tone?: RowActionTone;
    readonly pending?: boolean;
    // What a screen reader says when the word alone ("remove") doesn't name its row.
    readonly label?: string;
    readonly onClick: () => void;
    readonly children: ReactNode;
}) {
    return (
        <button
            type="button"
            className={styles.act}
            data-tone={tone}
            disabled={pending}
            aria-busy={pending}
            {...(label === undefined ? {} : { "aria-label": label })}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

// A row's end that is a state, not an action: "this one".
export function RowMark({ children }: { readonly children: ReactNode }) {
    return <span className={styles.mark}>{children}</span>;
}
