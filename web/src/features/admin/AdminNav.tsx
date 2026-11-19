import { Link } from "@tanstack/react-router";
import type { Viewer } from "../../viewer.ts";
import styles from "./AdminNav.module.css";
import { ADMIN_COPY } from "./copy.ts";
import { adminSections } from "./sections.ts";

// The admin side nav: only the sections the viewer may read, hidden rather than disabled.
export function AdminNav({ viewer }: { readonly viewer: Viewer }) {
    const sections = adminSections(viewer);
    const active = { "aria-current": "page" } as const;
    return (
        <ul className={styles.nav}>
            {sections.accounts ? (
                <li>
                    <Link to="/admin/accounts" className={styles.item} activeProps={active}>
                        {ADMIN_COPY.accounts}
                    </Link>
                </li>
            ) : null}
            {sections.roles ? (
                <li>
                    <Link to="/admin/roles" className={styles.item} activeProps={active}>
                        {ADMIN_COPY.roles}
                    </Link>
                </li>
            ) : null}
            {sections.audit ? (
                <li>
                    <Link to="/admin/audit" className={styles.item} activeProps={active}>
                        {ADMIN_COPY.audit}
                    </Link>
                </li>
            ) : null}
        </ul>
    );
}
