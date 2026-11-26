import type { ReactNode } from "react";
import { MAIN_ID } from "../SkipLink/SkipLink.tsx";
import styles from "./Page.module.css";

// Every page's anatomy, and the one place the page's geometry is decided: a gap, then a head row
// whose bottom edge is the first hairline, 80px under the bar. The head row holds the title with
// its trail and verbs; a page whose columns open with their own captions hides the title (it
// stays the page's h1 for screen readers) and the captions are the head row. "wide" fills the
// column up to --page; "narrow" is one thing's own page.
export function Page({
    title,
    hideTitle = false,
    trail,
    actions,
    width = "wide",
    children,
}: {
    readonly title: ReactNode;
    readonly hideTitle?: boolean;
    readonly trail?: ReactNode;
    readonly actions?: ReactNode;
    readonly width?: "wide" | "narrow";
    readonly children: ReactNode;
}) {
    return (
        <main id={MAIN_ID} className={styles.page} data-width={width} tabIndex={-1}>
            {hideTitle ? (
                <h1 className={styles.hidden}>{title}</h1>
            ) : (
                <header className={styles.head}>
                    <div className={styles.lead}>
                        {trail === undefined ? null : <nav className={styles.trail}>{trail}</nav>}
                        <h1 className={styles.title}>{title}</h1>
                    </div>
                    {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
                </header>
            )}
            <div className={styles.body} data-below-head={!hideTitle}>
                {children}
            </div>
        </main>
    );
}
