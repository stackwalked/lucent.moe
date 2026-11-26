import { Link, useMatchRoute, useRouteContext, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { chooseTheme } from "../../theme.ts";
import { Dropdown } from "../../ui/Dropdown/Dropdown.tsx";
import { Shell } from "../../ui/Shell/Shell.tsx";
import { forgetSession, memberOf, type Viewer } from "../../viewer.ts";
import { ADMIN_COPY } from "../admin/copy.ts";
import { isStaff } from "../admin/sections.ts";
import { signOut } from "../auth/session.ts";
import { inboxLabel } from "../inbox/copy.ts";
import { SHELL_COPY } from "./copy.ts";
import styles from "./SiteShell.module.css";

function AccountMenu({ viewer }: { readonly viewer: Viewer }) {
    const router = useRouter();
    return (
        <Dropdown
            label={SHELL_COPY.menu(viewer.username ?? "")}
            icon="user"
            items={[
                {
                    label: SHELL_COPY.graphite,
                    icon: "moon",
                    onSelect: () => void chooseTheme("graphite"),
                },
                { label: SHELL_COPY.washi, icon: "sun", onSelect: () => void chooseTheme("washi") },
                {
                    label: SHELL_COPY.systemTheme,
                    icon: "monitor",
                    onSelect: () => void chooseTheme("system"),
                },
                {
                    label: SHELL_COPY.signOut,
                    icon: "log-out",
                    onSelect: async () => {
                        await signOut();
                        forgetSession();
                        await router.navigate({ to: "/" });
                        await router.invalidate();
                    },
                },
            ]}
        />
    );
}

// The account's corner of the bar: its pages, unread notifications while there are any, and the
// menu. It stays beside the wordmark at every width; the places move to a row of their own. On
// the account's own pages the side nav carries the unread count, so the bar doesn't repeat it.
function AccountCorner({
    viewer,
    unreadCount,
}: {
    readonly viewer: Viewer;
    readonly unreadCount: number | null;
}) {
    const matchRoute = useMatchRoute();
    const onAccount = matchRoute({ to: "/account", fuzzy: true }) !== false;
    return (
        <>
            {onAccount || unreadCount === null || unreadCount === 0 ? null : (
                <Link
                    to="/account/inbox"
                    className={styles.place}
                    activeProps={{ "aria-current": "page" }}
                >
                    {inboxLabel(unreadCount)}
                </Link>
            )}
            <Link to="/account" className={styles.place} activeProps={{ "aria-current": "page" }}>
                {SHELL_COPY.account}
            </Link>
            <AccountMenu viewer={viewer} />
        </>
    );
}

// The frame of every page with the site's bar: the account's places and menu when signed in,
// "Sign in" when not.
export function SiteShell({
    side,
    children,
}: {
    readonly side?: ReactNode;
    readonly children: ReactNode;
}) {
    const { session, unreadCount } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    return (
        <Shell
            places={
                viewer === null ? (
                    <>
                        <Link
                            to="/status"
                            className={styles.place}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {SHELL_COPY.status}
                        </Link>
                        <Link
                            to="/apply"
                            className={styles.place}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {SHELL_COPY.apply}
                        </Link>
                        <Link to="/sign-in" className={styles.place}>
                            {SHELL_COPY.signIn}
                        </Link>
                    </>
                ) : (
                    <>
                        <Link
                            to="/products"
                            className={styles.place}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {SHELL_COPY.products}
                        </Link>
                        <Link
                            to="/cloud"
                            className={styles.place}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {SHELL_COPY.cloud}
                        </Link>
                        <Link
                            to="/download"
                            className={styles.place}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {SHELL_COPY.download}
                        </Link>
                        <Link
                            to="/resources"
                            className={styles.place}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {SHELL_COPY.resources}
                        </Link>
                        <Link
                            to="/tickets"
                            className={styles.place}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {SHELL_COPY.support}
                        </Link>
                        <Link
                            to="/status"
                            className={styles.place}
                            activeProps={{ "aria-current": "page" }}
                        >
                            {SHELL_COPY.status}
                        </Link>
                        {isStaff(viewer) ? (
                            <Link
                                to="/admin"
                                className={styles.place}
                                activeProps={{ "aria-current": "page" }}
                            >
                                {ADMIN_COPY.admin}
                            </Link>
                        ) : null}
                    </>
                )
            }
            {...(viewer === null
                ? {}
                : { account: <AccountCorner viewer={viewer} unreadCount={unreadCount} /> })}
            {...(side === undefined ? {} : { side })}
        >
            {children}
        </Shell>
    );
}
