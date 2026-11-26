import { useRouteContext } from "@tanstack/react-router";
import { SideNav, type SideNavItem } from "../../ui/SideNav/SideNav.tsx";
import { inboxLabel } from "../inbox/copy.ts";
import { SHELL_COPY } from "./copy.ts";

// The account's own pages, beside each of them; the top bar holds only "account".
export function AccountNav() {
    const { unreadCount } = useRouteContext({ from: "__root__" });
    const items: SideNavItem[] = [
        { to: "/account/security", label: SHELL_COPY.security },
        { to: "/account/devices", label: SHELL_COPY.devices },
        { to: "/account/inbox", label: inboxLabel(unreadCount) },
        { to: "/account/invites", label: SHELL_COPY.invites },
        { to: "/account/preferences", label: SHELL_COPY.preferences },
        { to: "/account/privacy", label: SHELL_COPY.privacy },
        { to: "/account/discord", label: SHELL_COPY.discord },
        { to: "/account/profile", label: SHELL_COPY.profile },
    ];
    return <SideNav label={SHELL_COPY.account} items={items} />;
}
