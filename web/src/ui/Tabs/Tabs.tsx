import { Link, type LinkProps } from "@tanstack/react-router";
import styles from "./Tabs.module.css";

export type Tab = {
    readonly to: NonNullable<LinkProps["to"]>;
    readonly params?: LinkProps["params"];
    readonly search?: LinkProps["search"];
    readonly label: string;
    readonly count?: number;
};

// A page's sub-tabs in its head row: links, the current one ink with a pink underline sitting on
// the head row's hairline, the rest ink-2 — the bar's tabs' own treatment. Where they outgrow
// the row they scroll inside themselves; the page never does.
export function Tabs({ tabs }: { readonly tabs: readonly Tab[] }) {
    return (
        <nav className={styles.tabs}>
            {tabs.map((tab) => (
                <Link
                    key={tab.label}
                    to={tab.to}
                    {...(tab.params === undefined ? {} : { params: tab.params })}
                    {...(tab.search === undefined ? {} : { search: tab.search })}
                    className={styles.tab}
                    activeProps={{ "aria-current": "page" }}
                    activeOptions={{ exact: true, includeSearch: false }}
                >
                    {tab.label}
                    {tab.count === undefined ? null : (
                        <span className={styles.count}>{tab.count}</span>
                    )}
                </Link>
            ))}
        </nav>
    );
}
