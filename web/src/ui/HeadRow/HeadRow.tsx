import type { ReactNode } from "react";
import styles from "./HeadRow.module.css";

// A column's head row: --caption-h tall with a hairline as its bottom edge, which is where a
// page's first hairline goes (80px under the bar) whatever the row holds. What leads it (a
// title, trail or tabs) sits at the start, small verbs at the end. Page's own head is one; so is
// the main column's in Columns.
export function HeadRow({
    lead,
    actions,
}: {
    readonly lead: ReactNode;
    readonly actions?: ReactNode;
}) {
    return (
        <header className={styles.head}>
            <div className={styles.lead}>{lead}</div>
            {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
        </header>
    );
}
