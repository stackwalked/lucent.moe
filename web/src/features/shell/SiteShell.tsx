import { Link, useLocation, useRouteContext, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { chooseTheme, currentTheme, type ThemeChoice } from "../../theme.ts";
import { Dropdown, type DropdownEntry } from "../../ui/Dropdown/Dropdown.tsx";
import { Icon } from "../../ui/Icon/Icon.tsx";
import { Shell } from "../../ui/Shell/Shell.tsx";
import { forgetSession, memberOf, type Viewer } from "../../viewer.ts";
import { ADMIN_COPY } from "../admin/copy.ts";
import { isStaff } from "../admin/sections.ts";
import { signOut } from "../auth/session.ts";
import { DOCS_COPY } from "../docs/copy.ts";
import { INBOX_TITLE, inboxLabel } from "../inbox/copy.ts";
import { SHELL_COPY } from "./copy.ts";
import styles from "./SiteShell.module.css";

const under = (pathname: string, base: string) =>
    pathname === base || pathname.startsWith(`${base}/`);
const PRODUCT_CLOUD = /^\/products\/[^/]+\/cloud(\/|$)/;

// What a signed-in member reaches from the bar, tab by tab, and which paths each one is current
// on: profiles are part of community, and a product's cloud tab belongs to cloud, not products.
// A link marks every place whose address is a prefix of the path, so each is exact and the
// place says for itself.
const PLACES = [
    { to: "/", label: SHELL_COPY.home, current: (path: string) => path === "/" },
    {
        to: "/products",
        label: SHELL_COPY.products,
        current: (path: string) => under(path, "/products") && !PRODUCT_CLOUD.test(path),
    },
    {
        to: "/cloud",
        label: SHELL_COPY.cloud,
        current: (path: string) => PRODUCT_CLOUD.test(path) || under(path, "/cloud"),
    },
    {
        to: "/community",
        label: SHELL_COPY.community,
        current: (path: string) => under(path, "/community") || under(path, "/members"),
    },
    {
        to: "/support",
        label: SHELL_COPY.support,
        current: (path: string) => under(path, "/support"),
    },
] as const;

const DOCS_PLACE = {
    to: "/docs",
    label: DOCS_COPY.title,
    current: (path: string) => under(path, "/docs"),
} as const;
// Profile, account, staff's admin, the theme, and sign out: everything of the member's own that isn't a
// place, behind their picture.
export function AccountMenu({
    viewer,
    avatar,
    discord,
}: {
    readonly viewer: Viewer;
    readonly avatar: string | null;
    // The community server's invite link, when the site has one.
    readonly discord: string | null;
}) {
    const router = useRouter();
    const [theme, setTheme] = useState<ThemeChoice>(currentTheme);
    const pick = (choice: ThemeChoice) => {
        setTheme(choice);
        void chooseTheme(choice);
    };
    const items: DropdownEntry[] = [
        {
            label: SHELL_COPY.profile,
            icon: "user",
            onSelect: () =>
                void router.navigate({
                    to: "/members/$username",
                    params: { username: viewer.username ?? "" },
                }),
        },
        {
            label: SHELL_COPY.account,
            icon: "key-round",
            onSelect: () => void router.navigate({ to: "/account" }),
        },
        ...(discord === null
            ? []
            : [
                  {
                      label: SHELL_COPY.discord,
                      icon: "external-link" as const,
                      onSelect: () => void window.open(discord, "_blank", "noopener,noreferrer"),
                  },
              ]),
    ];
    if (isStaff(viewer)) {
        items.push({
            label: ADMIN_COPY.admin,
            icon: "shield",
            onSelect: () => void router.navigate({ to: "/admin" }),
        });
    }
    items.push(
        { rule: "theme" },
        {
            label: SHELL_COPY.theme,
            choices: [
                {
                    label: SHELL_COPY.graphite,
                    icon: "moon",
                    current: theme === "graphite",
                    onSelect: () => pick("graphite"),
                },
                {
                    label: SHELL_COPY.washi,
                    icon: "sun",
                    current: theme === "washi",
                    onSelect: () => pick("washi"),
                },
                {
                    label: SHELL_COPY.systemTheme,
                    icon: "monitor",
                    current: theme === "system",
                    onSelect: () => pick("system"),
                },
            ],
        },
        { rule: "sign-out" },
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
export function SiteShell({ children }: { readonly children: ReactNode }) {
    const { session, unreadCount, avatar, docs, site } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const { pathname } = useLocation();
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
                      places: (docs ? [...PLACES, DOCS_PLACE] : PLACES).map(
                          ({ to, label, current }) => (
                              <Link
                                  key={to}
                                  to={to}
                                  className={styles.place}
                                  {...(current(pathname)
                                      ? { "aria-current": "page" as const }
                                      : {})}
                                  activeOptions={{ exact: true }}
                              >
                                  {label}
                              </Link>
                          ),
                      ),
                      account: (
                          <>
                              <Link
                                  to="/account/inbox"
                                  className={styles.inbox}
                                  aria-label={inboxLabel(unreadCount)}
                                  title={INBOX_TITLE}
                                  activeProps={{ "aria-current": "page" }}
                              >
                                  <Icon name="inbox" />
                                  {unreadCount === null || unreadCount === 0 ? null : (
                                      <span className={styles.dot} aria-hidden="true" />
                                  )}
                              </Link>
                              <AccountMenu
                                  viewer={viewer}
                                  avatar={avatar}
                                  discord={site.discordInvite}
                              />
                          </>
                      ),
                  })}
        >
            {children}
        </Shell>
    );
}
