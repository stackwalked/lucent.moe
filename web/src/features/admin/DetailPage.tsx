import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { ADMIN_COPY as C } from "./copy.ts";
import styles from "./DetailPage.module.css";
import type { From } from "./queue/from.ts";

// A staff detail page: the item on the left, its actions and the account's state on the right.
// The head row holds the way back (to the list it was opened from) and the title.
export function DetailPage({
    from,
    back,
    title,
    main,
    aside,
}: {
    readonly from: From | undefined;
    // Where the page goes back to when it was not opened from the queue.
    readonly back: {
        readonly to:
            | "/admin/queue/tickets"
            | "/admin/queue/applications"
            | "/admin/members/accounts";
        readonly label: string;
    };
    readonly title: ReactNode;
    readonly main: ReactNode;
    readonly aside: ReactNode;
}) {
    const link = (() => {
        switch (from) {
            case "all":
                return <Link to="/admin">{C.tabs.queue}</Link>;
            case "tickets":
                return <Link to="/admin/queue/tickets">{C.subs.tickets}</Link>;
            case "applications":
                return <Link to="/admin/queue/applications">{C.subs.applications}</Link>;
            case "reports":
                return <Link to="/admin/queue/reports">{C.subs.moderation}</Link>;
            case "flags":
                return <Link to="/admin/queue/flags">{C.subs.review}</Link>;
            case undefined:
                return <Link to={back.to}>{back.label}</Link>;
        }
    })();
    return (
        <Page title={null} hideTitle tabs={null}>
            <Columns
                head={{
                    lead: (
                        <>
                            <span className={styles.back}>{link}</span>
                            <h1 className={styles.title}>{title}</h1>
                        </>
                    ),
                }}
                main={main}
                aside={aside}
            />
        </Page>
    );
}
