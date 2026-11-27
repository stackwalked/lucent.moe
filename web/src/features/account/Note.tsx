import type { ReactNode } from "react";
import styles from "./Note.module.css";

// What a section says at the end of its caption, in words that are not an action: "2 left".
export function Note({ children }: { readonly children: ReactNode }) {
    return <span className={styles.note}>{children}</span>;
}
