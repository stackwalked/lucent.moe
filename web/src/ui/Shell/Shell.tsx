import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { UI_COPY } from "../copy.ts";
import { Logo } from "../Logo/Logo.tsx";
import { SkipLink } from "../SkipLink/SkipLink.tsx";
import styles from "./Shell.module.css";

// The frame of every page with the site's bar: the mark and wordmark, the places as tabs, and the
// account's corner; below it, the section's side nav when there is one, and the page. The bar's
// hairline spans the window; what sits on it shares the page's column. Sign-in and setup use
// "bare": the page alone, as a centred card.
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
                <div className={styles.column}>
                    <Link to="/" className={styles.brand}>
                        <Logo />
                        lucent
                    </Link>
                    {places === undefined ? null : (
                        <nav className={styles.places} aria-label={UI_COPY.places}>
                            {places}
                        </nav>
                    )}
                    {account === undefined ? null : <div className={styles.account}>{account}</div>}
                </div>
            </header>
            <div className={styles.frame} data-side={side === undefined ? "none" : "nav"}>
                {side === undefined ? null : <div className={styles.side}>{side}</div>}
                <div className={styles.content}>{children}</div>
            </div>
        </div>
    );
}
