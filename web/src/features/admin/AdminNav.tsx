import { Link } from "@tanstack/react-router";
import type { Viewer } from "../../viewer.ts";
import styles from "./AdminNav.module.css";
import { ADMIN_COPY } from "./copy.ts";
import { adminSections, SECTION_PATHS } from "./sections.ts";

// The admin side nav: only the sections the viewer may read, hidden rather than disabled.
export function AdminNav({ viewer }: { readonly viewer: Viewer }) {
    const sections = adminSections(viewer);
    return (
        <ul className={styles.nav}>
            {SECTION_PATHS.filter(([section]) => sections[section]).map(([section, path]) => (
                <li key={section}>
                    <Link
                        to={path}
                        className={styles.item}
                        activeProps={{ "aria-current": "page" }}
                    >
                        {ADMIN_COPY[section]}
                    </Link>
                </li>
            ))}
        </ul>
    );
}
