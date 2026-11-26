import { getRouteApi, Link } from "@tanstack/react-router";
import { Page } from "../../../ui/Page/Page.tsx";
import { MODERATION_COPY } from "./copy.ts";
import { ReportsSection } from "./ReportsSection.tsx";
import { RestrictionsSection } from "./RestrictionsSection.tsx";
import { MODERATION_TITLE } from "./title.ts";

const route = getRouteApi("/_admin/admin/queue/reports");

// One list at a time, each with its own paging: the reports queue, or the active restrictions.
export function ModerationPage() {
    const { list } = route.useLoaderData();
    return (
        <Page
            title={MODERATION_TITLE}
            actions={
                list.kind === "reports" ? (
                    <Link to="/admin/queue/reports" search={{ view: "restrictions" }}>
                        {MODERATION_COPY.showRestrictions}
                    </Link>
                ) : (
                    <Link to="/admin/queue/reports">{MODERATION_COPY.showReports}</Link>
                )
            }
        >
            {list.kind === "reports" ? (
                <ReportsSection outcome={list.outcome} />
            ) : (
                <RestrictionsSection outcome={list.outcome} products={list.products} />
            )}
        </Page>
    );
}
