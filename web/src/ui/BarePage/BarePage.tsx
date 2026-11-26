import type { ReactNode } from "react";
import { MAIN_ID } from "../SkipLink/SkipLink.tsx";
import styles from "./BarePage.module.css";

// What a bare page (no site bar) holds: its h1, then the form or the message, in the one column
// the bare Shell gives it. `actions` are the small ways out (leave, sign out).
export function BarePage({
    title,
    actions,
    children,
}: {
    readonly title: ReactNode;
    readonly actions?: ReactNode;
    readonly children: ReactNode;
}) {
    return (
        <main id={MAIN_ID} className={styles.page} tabIndex={-1}>
            <h1 className={styles.title}>{title}</h1>
            {children}
            {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
        </main>
    );
}
