import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { chooseTheme } from "../../theme.ts";
import { Dropdown, type DropdownItem } from "../../ui/Dropdown/Dropdown.tsx";
import { Shell } from "../../ui/Shell/Shell.tsx";
import { forgetSession, memberOf, type Viewer } from "../../viewer.ts";
import { ADMIN_COPY } from "../admin/copy.ts";
import { isStaff } from "../admin/sections.ts";
import { signOut } from "../auth/session.ts";
import { inboxLabel } from "../inbox/copy.ts";
import { SHELL_COPY } from "./copy.ts";
import styles from "./SiteShell.module.css";

// What a signed-in member reaches from the bar, tab by tab.
const PLACES = [
    { to: "/products", label: SHELL_COPY.products },
    { to: "/cloud", label: SHELL_COPY.cloud },
    { to: "/resources", label: SHELL_COPY.resources },
    { to: "/support", label: SHELL_COPY.support },
] as const;

// Account, staff's admin, the theme, and sign out: everything of the member's own that isn't a
// place, behind their picture.
function AccountMenu({
    viewer,
    avatar,
}: {
    readonly viewer: Viewer;
    readonly avatar: string | null;
}) {
    const router = useRouter();
    const items: DropdownItem[] = [
        {
            label: SHELL_COPY.account,
            icon: "user",
            onSelect: () => void router.navigate({ to: "/account" }),
        },
    ];
    if (isStaff(viewer)) {
        items.push({
            label: ADMIN_COPY.admin,
            icon: "shield",
            onSelect: () => void router.navigate({ to: "/admin" }),
        });
    }
    items.push(
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
    );
    return (
        <Dropdown
            label={SHELL_COPY.menu(viewer.username ?? "")}
            icon="user"
            picture={avatar}
            items={items}
        />
    );
}

// The frame of every page with the site's bar: the places and the account's corner when signed
// in, only "sign in" when not.
export function SiteShell({
    side,
    children,
}: {
    readonly side?: ReactNode;
    readonly children: ReactNode;
}) {
    const { session, unreadCount, avatar } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    return (
        <Shell
            {...(viewer === null
                ? {
                      account: (
                          <Link to="/sign-in" className={styles.corner}>
                              {SHELL_COPY.signIn}
                          </Link>
                      ),
                  }
                : {
                      places: PLACES.map(({ to, label }) => (
                          <Link
                              key={to}
                              to={to}
                              className={styles.place}
                              activeProps={{ "aria-current": "page" }}
                          >
                              {label}
                          </Link>
                      )),
                      account: (
                          <>
                              <Link
                                  to="/account/inbox"
                                  className={styles.corner}
                                  activeProps={{ "aria-current": "page" }}
                              >
                                  {inboxLabel(unreadCount)}
                              </Link>
                              <AccountMenu viewer={viewer} avatar={avatar} />
                          </>
                      ),
                  })}
            {...(side === undefined ? {} : { side })}
        >
            {children}
        </Shell>
    );
}
