import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SkipLink } from "../SkipLink/SkipLink.tsx";
import styles from "./Shell.module.css";

// The frame of every signed-in page: a bar with the wordmark, the account's places and its menu;
// below it, the admin side nav when there is one, and the page. Sign-in and setup use "bare": the
// page alone, as a centred card.
export function Shell({
    layout = "app",
    places,
    account,
    side,
    children,
}: {
    readonly layout?: "app" | "bare";
    readonly places?: ReactNode;
    readonly account?: ReactNode;
    readonly side?: ReactNode;
    readonly children: ReactNode;
}) {
    if (layout === "bare") {
        return (
            <div className={styles.bare}>
                <SkipLink />
                <div className={styles.card}>{children}</div>
            </div>
        );
    }
    return (
        <div className={styles.shell}>
            <SkipLink />
            <header className={styles.bar}>
                <Link to="/" className={styles.wordmark}>
                    lucent
                </Link>
                {places === undefined ? null : <nav className={styles.places}>{places}</nav>}
                {account === undefined ? null : <div className={styles.account}>{account}</div>}
            </header>
            <div className={styles.frame} data-side={side === undefined ? "none" : "nav"}>
                {side === undefined ? null : <nav className={styles.side}>{side}</nav>}
                <div className={styles.content}>{children}</div>
            </div>
        </div>
    );
}
