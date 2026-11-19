import type { ReactNode } from "react";
import { UI_COPY } from "../copy.ts";
import { Icon } from "../Icon/Icon.tsx";
import styles from "./Refusal.module.css";

// A refusal the reader should hear now: announced as it appears. One message; an unexpected
// failure also gives the reference support asks for.
export function Refusal({
    reference,
    children,
}: {
    readonly reference?: string;
    readonly children: ReactNode;
}) {
    return (
        <div className={styles.refusal} role="alert">
            <span className={styles.mark}>
                <Icon name="triangle-alert" />
            </span>
            <div className={styles.text}>
                <p>{children}</p>
                {reference === undefined ? null : (
                    <p className={styles.reference}>
                        {UI_COPY.reference}: <code>{reference}</code>
                    </p>
                )}
            </div>
        </div>
    );
}
