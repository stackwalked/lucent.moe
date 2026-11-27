import { useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { type Pair, Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Tabs } from "../../ui/Tabs/Tabs.tsx";
import { ACCOUNT_COPY as C } from "./copy.ts";

// One account area: the sub-tabs in the main column's head row (the page's h1 is "account",
// hidden), the thing you edit on the left and, where the page already holds the data, a short
// block of current state on the right. Without an aside the page is the main column alone.
export function AccountPage({
    main,
    aside,
}: {
    readonly main: ReactNode;
    readonly aside?: ReactNode;
}) {
    const { unreadCount } = useRouteContext({ from: "__root__" });
    return (
        <Page title={C.title} hideTitle>
            <Columns
                head={{
                    lead: (
                        <Tabs
                            tabs={[
                                { to: "/account/security", label: C.security },
                                { to: "/account/devices", label: C.devices },
                                { to: "/account/invites", label: C.invites },
                                {
                                    to: "/account/inbox",
                                    label: C.inbox,
                                    ...(unreadCount === null || unreadCount === 0
                                        ? {}
                                        : { count: unreadCount }),
                                },
                                { to: "/account/privacy", label: C.privacy },
                                { to: "/account/discord", label: C.discord },
                                { to: "/account/preferences", label: C.preferences },
                            ]}
                        />
                    ),
                }}
                main={main}
                {...(aside === undefined ? {} : { aside })}
            />
        </Page>
    );
}

// The right column's block: a caption and end-aligned pairs.
export function State({
    caption,
    items,
}: {
    readonly caption: string;
    readonly items: readonly Pair[];
}) {
    return (
        <Section caption={caption}>
            <Pairs items={items} align="end" />
        </Section>
    );
}
