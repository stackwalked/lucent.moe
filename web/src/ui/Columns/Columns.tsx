import type { ReactNode } from "react";
import { HeadRow } from "../HeadRow/HeadRow.tsx";
import styles from "./Columns.module.css";

// A page's two columns: wide, then --aside, a gap between, both starting at the same height. Each
// column opens with its own head row (the main column's `head`, the aside's first Section
// caption), so the first hairline of each is on one line and none crosses the gap. One column
// where the page is too narrow for both.
export function Columns({
    head,
    main,
    aside,
}: {
    // The main column's head row: what leads it (a title, tabs) and small verbs at its end.
    readonly head?: { readonly lead: ReactNode; readonly actions?: ReactNode };
    readonly main: ReactNode;
    // Without one the main column stands alone, at the width it has beside an aside.
    readonly aside?: ReactNode;
}) {
    return (
        <div className={styles.columns}>
            <div className={styles.column}>
                {head === undefined ? (
                    main
                ) : (
                    <div className={styles.headed} data-below-head="true">
                        <HeadRow
                            lead={head.lead}
                            {...(head.actions === undefined ? {} : { actions: head.actions })}
                        />
                        {main}
                    </div>
                )}
            </div>
            {aside === undefined ? null : <div className={styles.column}>{aside}</div>}
        </div>
    );
}
