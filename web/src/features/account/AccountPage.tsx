import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { memberOf } from "../../viewer.ts";
import { PcsSection } from "../devices/PcsSection.tsx";
import { DiscordSection } from "../discord/DiscordSection.tsx";
import { InvitesSection } from "../invites/InvitesSection.tsx";
import { NotificationsSection } from "../preferences/NotificationsSection.tsx";
import { AccountSection } from "../privacy/AccountSection.tsx";
import { PrivacySection } from "../privacy/PrivacySection.tsx";
import { SessionsSection } from "../security/SessionsSection.tsx";
import { SignInSection } from "../security/SignInSection.tsx";
import { ACCOUNT_COPY as C } from "./copy.ts";

const route = getRouteApi("/_member/account/");

// The whole account on one page: the settings in the wide column, each a row of what it is, its
// value and what to do about it; the things that are lists (pcs, where you're signed in,
// invites) in the narrow one. Each column opens with its first caption, which is its head row.
export function AccountPage() {
    const loaded = route.useLoaderData();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    return (
        <Page title={C.title} hideTitle>
            <Columns
                main={
                    <>
                        <SignInSection
                            credentials={loaded.credentials}
                            username={viewer?.username ?? ""}
                        />
                        <NotificationsSection preferences={loaded.preferences} />
                        <DiscordSection
                            link={loaded.discord}
                            configured={loaded.discordConfigured}
                        />
                        <PrivacySection privacy={loaded.privacy} />
                        <AccountSection dueAt={viewer?.deletionDueAt ?? null} />
                    </>
                }
                aside={
                    <>
                        <PcsSection devices={loaded.devices} />
                        <SessionsSection sessions={loaded.sessions} />
                        <InvitesSection invites={loaded.invites} />
                    </>
                }
            />
        </Page>
    );
}
