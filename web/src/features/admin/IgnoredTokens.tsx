import { ADMIN_COPY } from "./copy.ts";
import styles from "./IgnoredTokens.module.css";

// Filter tokens a list couldn't use, said back so it never looks filtered when it isn't.
export function IgnoredTokens({ tokens }: { readonly tokens: readonly string[] }) {
    if (tokens.length === 0) return null;
    return <p className={styles.ignored}>{ADMIN_COPY.ignored(tokens.join(" "))}</p>;
}
