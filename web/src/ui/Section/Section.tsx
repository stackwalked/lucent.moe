import { type ReactNode, useId } from "react";
import styles from "./Section.module.css";

// A captioned part of a page: the caption sits on a hairline, one height wherever it is, with
// the section's own small actions at its end.
export function Section({
    caption,
    actions,
    children,
}: {
    readonly caption: ReactNode;
    readonly actions?: ReactNode;
    readonly children: ReactNode;
}) {
    const id = useId();
    return (
        <section className={styles.section} aria-labelledby={id}>
            <div className={styles.caption}>
                <h2 id={id} className={styles.label}>
                    {caption}
                </h2>
                {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
            </div>
            {children}
        </section>
    );
}
