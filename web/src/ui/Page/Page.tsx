import type { ReactNode } from "react";
import { MAIN_ID } from "../SkipLink/SkipLink.tsx";
import styles from "./Page.module.css";

// Every page's anatomy: a trail (back link or breadcrumb), one h1 with the page's verbs on its
// line, then sections. "wide" fills the window up to --page; "narrow" is one thing's own page.
export function Page({
    title,
    trail,
    actions,
    width = "wide",
    children,
}: {
    readonly title: ReactNode;
    readonly trail?: ReactNode;
    readonly actions?: ReactNode;
    readonly width?: "wide" | "narrow";
    readonly children: ReactNode;
}) {
    return (
        <main id={MAIN_ID} className={styles.page} data-width={width} tabIndex={-1}>
            {trail === undefined ? null : <nav className={styles.trail}>{trail}</nav>}
            <header className={styles.head}>
                <h1 className={styles.title}>{title}</h1>
                {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
            </header>
            <div className={styles.body}>{children}</div>
        </main>
    );
}
