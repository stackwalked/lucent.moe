import { Tabs } from "../../ui/Tabs/Tabs.tsx";
import { COMMUNITY_COPY as C } from "./copy.ts";

// The community's two places, in the head row of both.
export function CommunityTabs() {
    return (
        <Tabs
            tabs={[
                { to: "/community", label: C.members },
                { to: "/community/guides", label: C.guides },
            ]}
        />
    );
}
