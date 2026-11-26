import type { ReactNode } from "react";
import styles from "./Columns.module.css";

// A page's two columns: wide, then --aside, a gap between, both starting at the same height. Each
// column opens with its own Section caption, so a hairline never crosses the gap. One column
// where the page is too narrow for both.
export function Columns({ main, aside }: { readonly main: ReactNode; readonly aside: ReactNode }) {
    return (
        <div className={styles.columns}>
            <div className={styles.column}>{main}</div>
            <div className={styles.column}>{aside}</div>
        </div>
    );
}
