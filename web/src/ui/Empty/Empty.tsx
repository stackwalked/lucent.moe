import type { ReactNode } from "react";
import styles from "./Empty.module.css";

// Nothing here yet: one short line, and the action that would change that, if there is one.
export function Empty({
    action,
    children,
}: {
    readonly action?: ReactNode;
    readonly children: ReactNode;
}) {
    return (
        <div className={styles.empty}>
            <p className={styles.line}>{children}</p>
            {action}
        </div>
    );
}
