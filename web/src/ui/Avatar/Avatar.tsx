import type { ReactNode } from "react";
import styles from "./Avatar.module.css";

// A member's picture, fetched by digest from web's avatar route. Pass the 64 px image's digest
// for `small` and the 256 px one's for `large`. It always sits beside the member's name, so it is
// decoration to a screen reader; no digest, no picture.
export function Avatar({
    digest,
    size,
}: {
    readonly digest: string | null;
    readonly size: "small" | "large";
}) {
    if (digest === null) return null;
    return (
        <img
            className={size === "large" ? styles.large : styles.small}
            src={`/avatars/${digest}`}
            width={size === "large" ? 128 : 24}
            height={size === "large" ? 128 : 24}
            alt=""
            loading="lazy"
            decoding="async"
        />
    );
}

// A name with the small picture before it, for author lines and cells.
export function Named({
    avatar,
    children,
}: {
    readonly avatar: string | null;
    readonly children: ReactNode;
}) {
    return (
        <span className={styles.named}>
            <Avatar digest={avatar} size="small" />
            {children}
        </span>
    );
}
