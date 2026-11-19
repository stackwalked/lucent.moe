import type { ReactNode } from "react";
import { UI_COPY } from "../copy.ts";
import { Icon } from "../Icon/Icon.tsx";
import styles from "./ExternalLink.module.css";

// The only <a href> leaving the site: a new tab, no opener, no referrer (the page sends none
// anyway), and a mark saying so.
export function ExternalLink({
    href,
    children,
}: {
    readonly href: string;
    readonly children: ReactNode;
}) {
    return (
        <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
            {children}
            <Icon name="external-link" label={UI_COPY.opensElsewhere} />
        </a>
    );
}
