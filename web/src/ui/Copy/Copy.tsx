import { tryAsync } from "@lucent/core/contain";
import { useEffect, useState } from "react";
import { UI_COPY } from "../copy.ts";
import { IconButton } from "../IconButton/IconButton.tsx";
import styles from "./Copy.module.css";

const SHOWN_MS = 1500;

// Puts `value` on the clipboard. The check shows for a moment, and "Copied" is said to screen
// readers from a live region of its own, so this works without a toast provider.
export function Copy({ value }: { readonly value: string }) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), SHOWN_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    async function copy() {
        const result = await tryAsync(
            () => navigator.clipboard.writeText(value),
            () => "clipboard unavailable",
        );
        if (result.ok) setCopied(true);
    }

    return (
        <span className={styles.copy}>
            <IconButton
                icon={copied ? "check" : "copy"}
                label={UI_COPY.copy}
                size="sm"
                onClick={copy}
            />
            <span className={styles.live} role="status">
                {copied ? UI_COPY.copied : ""}
            </span>
        </span>
    );
}
