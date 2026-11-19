import { Copy } from "../Copy/Copy.tsx";
import styles from "./Ident.module.css";
import { shortenIdent } from "./shorten.ts";

// An id in monospace: shortened in the middle when long, whole in the title and on the clipboard.
export function Ident({ value }: { readonly value: string }) {
    return (
        <span className={styles.ident}>
            <code className={styles.value} title={value}>
                {shortenIdent(value)}
            </code>
            <Copy value={value} />
        </span>
    );
}
