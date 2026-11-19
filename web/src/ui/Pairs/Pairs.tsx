import type { ReactNode } from "react";
import styles from "./Pairs.module.css";

export type Pair = { readonly label: string; readonly value: ReactNode };

// Labels and their values for a detail page, as a description list: labels down the left, values
// beside them.
export function Pairs({ items }: { readonly items: readonly Pair[] }) {
    return (
        <dl className={styles.pairs}>
            {items.map((item) => (
                <div key={item.label} className={styles.pair}>
                    <dt className={styles.label}>{item.label}</dt>
                    <dd className={styles.value}>{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}
