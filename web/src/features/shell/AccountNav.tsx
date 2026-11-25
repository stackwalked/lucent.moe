import { useRouteContext } from "@tanstack/react-router";
import { SideNav, type SideNavItem } from "../../ui/SideNav/SideNav.tsx";
import { memberOf } from "../../viewer.ts";
import { inboxLabel } from "../inbox/copy.ts";
import { SHELL_COPY } from "./copy.ts";

// The account's own pages, beside each of them; the top bar holds only "account".
export function AccountNav() {
    const { session, unreadCount } = useRouteContext({ from: "__root__" });
    const username = memberOf(session)?.username ?? null;
    const items: SideNavItem[] = [
        { to: "/account/security", label: SHELL_COPY.security },
        { to: "/account/devices", label: SHELL_COPY.devices },
        { to: "/account/inbox", label: inboxLabel(unreadCount) },
        { to: "/account/invites", label: SHELL_COPY.invites },
        { to: "/account/preferences", label: SHELL_COPY.preferences },
        { to: "/account/privacy", label: SHELL_COPY.privacy },
        { to: "/account/discord", label: SHELL_COPY.discord },
    ];
    if (username !== null) {
        items.push({ to: "/members/$username", params: { username }, label: SHELL_COPY.profile });
    }
    return <SideNav label={SHELL_COPY.account} items={items} />;
}
