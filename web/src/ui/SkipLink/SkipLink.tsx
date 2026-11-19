import { UI_COPY } from "../copy.ts";
import styles from "./SkipLink.module.css";

export const MAIN_ID = "main";

// The first focusable thing on every page: keyboard users go straight past the nav.
export function SkipLink() {
    return (
        <a className={styles.skip} href={`#${MAIN_ID}`}>
            {UI_COPY.skipToContent}
        </a>
    );
}
