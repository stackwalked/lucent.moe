import { getRouteApi, Link, useLocation, useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageTabsContext } from "../../ui/Page/Page.tsx";
import { Shell } from "../../ui/Shell/Shell.tsx";
import { Tabs } from "../../ui/Tabs/Tabs.tsx";
import { memberOf, viewerCan } from "../../viewer.ts";
import shellStyles from "../shell/SiteShell.module.css";
import { AccountMenu } from "../shell/SiteShell.tsx";
import styles from "./AdminShell.module.css";
import { ADMIN_COPY as C } from "./copy.ts";
import { AdminSearch } from "./search/AdminSearch.tsx";
import { visibleTabs } from "./sections.ts";

// The staff area's frame: its own bar (the mark, "staff", the five tabs, the search box, the way
// back to the site, the avatar menu) and, in each page's head row, the sub-tabs of the tab it is
// in. Both show only what the viewer may do something in.
const adminRoute = getRouteApi("/_admin");

export function AdminShell({ children }: { readonly children: ReactNode }) {
    const { session, avatar, site } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const { pathname } = useLocation();
    const { counts, total } = adminRoute.useLoaderData();
    if (viewer === null) return null;
    const tabs = visibleTabs(viewer);
    const current =
        tabs.find(({ tab }) => pathname.startsWith(`/admin/${tab}`)) ??
        (pathname === "/admin" ? tabs.find(({ tab }) => tab === "queue") : undefined);
    const countOf = (section: string): string | undefined =>
        section === "queue"
            ? (total ?? undefined)
            : section === "tickets" ||
                section === "applications" ||
                section === "reports" ||
                section === "flags" ||
                section === "listings"
              ? counts[section]
              : undefined;
    const subTabs =
        current === undefined ? null : (
            <Tabs
                tabs={current.subs.map((sub) => {
                    const count = countOf(
                        sub.section === "moderation"
                            ? "reports"
                            : sub.section === "review"
                              ? "flags"
                              : sub.section === "cloud"
                                ? "listings"
                                : sub.section,
                    );
                    return {
                        to: sub.to,
                        label: C.subs[sub.section],
                        ...(count === undefined ? {} : { count }),
                    };
                })}
            />
        );
    const searches = viewerCan(viewer, "accounts:read") || viewerCan(viewer, "tickets:reply");
    return (
        <Shell
            badge={<span className={styles.badge}>{C.staff}</span>}
            places={tabs.map(({ tab, subs }) => (
                <Link
                    key={tab}
                    to={subs[0]?.to ?? "/admin"}
                    className={shellStyles.place}
                    activeOptions={{ exact: true }}
                    {...(current?.tab === tab ? { "aria-current": "page" as const } : {})}
                >
                    {C.tabs[tab]}
                    {tab === "queue" && total !== null ? (
                        <span className={styles.count}>{total}</span>
                    ) : null}
                </Link>
            ))}
            account={
                <>
                    {searches ? <AdminSearch /> : null}
                    <Link to="/" className={shellStyles.corner}>
                        {C.backToSite}
                    </Link>
                    <AccountMenu viewer={viewer} avatar={avatar} discord={site.discordInvite} />
                </>
            }
        >
            <PageTabsContext value={subTabs}>{children}</PageTabsContext>
        </Shell>
    );
}
