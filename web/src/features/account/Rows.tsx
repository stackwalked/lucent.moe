import type { ReactNode } from "react";
import styles from "./Rows.module.css";

export type Row = {
    readonly key: string;
    readonly main: ReactNode;
    readonly meta?: ReactNode;
    readonly action?: ReactNode;
};

// A list as rows divided by hairlines: what it is, a little about it in ink-2, and the action at
// the row's end.
export function Rows({ label, items }: { readonly label: string; readonly items: readonly Row[] }) {
    return (
        <ul className={styles.rows} aria-label={label}>
            {items.map((item) => (
                <li key={item.key} className={styles.row}>
                    <span className={styles.main}>{item.main}</span>
                    {item.meta === undefined ? null : (
                        <span className={styles.meta}>{item.meta}</span>
                    )}
                    {item.action === undefined ? null : (
                        <span className={styles.action}>{item.action}</span>
                    )}
                </li>
            ))}
        </ul>
    );
}
