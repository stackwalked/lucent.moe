import { Link, type LinkProps, useLocation } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import styles from "./SideNav.module.css";

export type SideNavItem = {
    readonly to: NonNullable<LinkProps["to"]>;
    readonly label: string;
    readonly params?: LinkProps["params"];
};

// A section's own places: a column beside the page, and on a phone one row that scrolls sideways
// on its own, so every place stays one tap away without pushing the page down.
export function SideNav({
    label,
    items,
}: {
    readonly label: string;
    readonly items: readonly SideNavItem[];
}) {
    const list = useRef<HTMLUListElement>(null);
    const { pathname } = useLocation();
    // In the row the current place can sit past the edge; bring it into view without moving the
    // page, which scrollIntoView would.
    useLayoutEffect(() => {
        const row = list.current;
        const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
        if (row === null || row === undefined || current === null || current === undefined) return;
        // Once per page, so a row the reader has scrolled stays where they put it.
        if (row.dataset["shownFor"] === pathname) return;
        row.dataset["shownFor"] = pathname;
        if (row.scrollWidth <= row.clientWidth) return;
        // The row is positioned in that layout, so offsetLeft is measured from its start.
        row.scrollLeft = current.offsetLeft;
    }, [pathname]);
    return (
        <nav aria-label={label}>
            <ul ref={list} className={styles.list}>
                {items.map((item) => (
                    <li key={item.label}>
                        <Link
                            to={item.to}
                            {...(item.params === undefined ? {} : { params: item.params })}
                            className={styles.item}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {item.label}
                        </Link>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
