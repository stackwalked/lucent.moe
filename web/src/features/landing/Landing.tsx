import { Link } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { Logo } from "../../ui/Logo/Logo.tsx";
import { SHELL_COPY } from "../shell/copy.ts";
import styles from "./Landing.module.css";

// What a visitor who isn't signed in sees at "/": the mark and two ways in, on an otherwise empty
// page. No bar, no wordmark; the name is the page's h1 for screen readers.
export function Landing() {
    return (
        <main className={styles.landing}>
            <h1 className={styles.name}>{SITE_COPY.name}</h1>
            <Logo size="landing" />
            <nav className={styles.door}>
                <Link to="/apply" className={styles.apply}>
                    {SHELL_COPY.apply}
                </Link>
                <Link to="/sign-in" className={styles.signIn}>
                    {SHELL_COPY.signIn}
                </Link>
            </nav>
        </main>
    );
}
