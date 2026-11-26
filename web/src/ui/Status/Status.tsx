import type { ReactNode } from "react";
import { Icon, type IconName } from "../Icon/Icon.tsx";
import styles from "./Status.module.css";

// neutral: a plain state; pink: yours or current; shu: stopped or refused; ok and wait: product
// and ticket states only.
export type StatusTone = "neutral" | "pink" | "shu" | "ok" | "wait";

// A small badge for the state of a thing. The word is what says it; the tone only helps.
export function Status({
    tone = "neutral",
    icon,
    children,
}: {
    readonly tone?: StatusTone;
    readonly icon?: IconName;
    readonly children: ReactNode;
}) {
    return (
        <span className={styles.status} data-tone={tone}>
            {icon === undefined ? null : <Icon name={icon} />}
            {children}
        </span>
    );
}
