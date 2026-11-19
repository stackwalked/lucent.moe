import { Copy } from "../Copy/Copy.tsx";
import styles from "./Code.module.css";

// A block of monospaced text (a setup link, a command) with the button that copies it. The
// button sits beside the well: on sunken only ink is readable, and the button's icon is ink-2.
export function Code({ children }: { readonly children: string }) {
    return (
        <div className={styles.code}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling block must be reachable by keyboard */}
            <pre className={styles.well} tabIndex={0}>
                <code>{children}</code>
            </pre>
            <Copy value={children} />
        </div>
    );
}
