import type { ReactNode } from "react";
import styles from "./Pairs.module.css";

export type Pair = {
    readonly label: string;
    readonly value: ReactNode;
    // A state word's hue: ok, wait and shu in their inks, dim ink-2. Nothing tones a value
    // that is not a state.
    readonly tone?: "ok" | "wait" | "shu" | "dim";
};

// Labels and their values for a detail page, as a description list. The default lays labels
// down the left with values beside them; "end" is the right column's rows: label at the row's
// start, value at its end, one row's height each.
export function Pairs({
    items,
    align,
}: {
    readonly items: readonly Pair[];
    readonly align?: "end";
}) {
    return (
        <dl className={styles.pairs} data-align={align}>
            {items.map((item) => (
                <div key={item.label} className={styles.pair}>
                    <dt className={styles.label}>{item.label}</dt>
                    <dd className={styles.value} data-tone={item.tone}>
                        {item.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}
