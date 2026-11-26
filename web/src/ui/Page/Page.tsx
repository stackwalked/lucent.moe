import type { ReactNode } from "react";
import { HeadRow } from "../HeadRow/HeadRow.tsx";
import { MAIN_ID } from "../SkipLink/SkipLink.tsx";
import styles from "./Page.module.css";

// Every page's anatomy, and the one place the page's geometry is decided: a gap, then a head row
// whose bottom edge is the first hairline, 80px under the bar. A one-column page's head row
// holds the title with its trail, tabs and verbs. A two-column page has no page-wide head row:
// nothing below the bar spans both columns, so its main column opens with its own (Columns'
// `head`) and the page's h1 is hidden (or null, when that head holds the visible h1). "wide"
// fills the column up to --page; "narrow" is one thing's own page.
export function Page({
    title,
    hideTitle = false,
    trail,
    tabs,
    actions,
    width = "wide",
    children,
}: {
    readonly title: ReactNode;
    readonly hideTitle?: boolean;
    readonly trail?: ReactNode;
    // The page's sub-tabs (ui/Tabs), after the title in the head row. With a hidden title they
    // still get the head row: the tabs name the page.
    readonly tabs?: ReactNode;
    readonly actions?: ReactNode;
    readonly width?: "wide" | "narrow";
    readonly children: ReactNode;
}) {
    const headed = !hideTitle || tabs !== undefined || actions !== undefined;
    const heading =
        title === null ? null : (
            <h1 className={hideTitle ? styles.hidden : styles.title}>{title}</h1>
        );
    return (
        <main id={MAIN_ID} className={styles.page} data-width={width} tabIndex={-1}>
            {headed ? (
                <HeadRow
                    lead={
                        <>
                            {trail === undefined ? null : (
                                <nav className={styles.trail}>{trail}</nav>
                            )}
                            {heading}
                            {tabs}
                        </>
                    }
                    {...(actions === undefined ? {} : { actions })}
                />
            ) : (
                heading
            )}
            <div className={styles.body} data-below-head={headed}>
                {children}
            </div>
        </main>
    );
}
