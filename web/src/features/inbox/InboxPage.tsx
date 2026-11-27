import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pager } from "../../ui/Pager/Pager.tsx";
import { RowAction, SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { Note } from "../account/Note.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { INBOX_COPY, INBOX_TITLE } from "./copy.ts";
import styles from "./InboxPage.module.css";
import { markInboxRead } from "./server.ts";

const route = getRouteApi("/_member/account/inbox");

// The member's notices, newest first, in the wide column under its own head row. Nothing sits in
// the narrow one: there is nothing else to say about a notice.
export function InboxPage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const [marking, setMarking] = useState<string | null>(null);
    const mark = async (id: string) => {
        setMarking(id);
        const reply = await markInboxRead({ data: { id } });
        setMarking(null);
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    return (
        <Page title={null} hideTitle>
            <Columns
                head={{ lead: <h1 className={styles.title}>{INBOX_TITLE}</h1> }}
                main={
                    <>
                        <RefusalNote refused={outcome.ok ? refused : outcome.refused} />
                        {!outcome.ok ? null : outcome.value.items.length === 0 ? (
                            <Empty>{INBOX_COPY.empty}</Empty>
                        ) : (
                            <>
                                <SettingRows label={INBOX_TITLE}>
                                    {outcome.value.items.map((item) => (
                                        <SettingRow
                                            key={item.id}
                                            layout="item"
                                            name={(() => {
                                                switch (item.kind) {
                                                    case "security":
                                                        return INBOX_COPY.security;
                                                    case "product_status":
                                                        return INBOX_COPY.product(item.productId);
                                                    case "subscription_ending":
                                                        return item.productId === null ? (
                                                            <>
                                                                {INBOX_COPY.aSubscription}{" "}
                                                                {INBOX_COPY.ends}{" "}
                                                                <Time
                                                                    at={item.endsAt}
                                                                    format="date"
                                                                />
                                                            </>
                                                        ) : (
                                                            <Link
                                                                to="/products/$productId"
                                                                params={{
                                                                    productId: item.productId,
                                                                }}
                                                                className={styles.link}
                                                            >
                                                                {item.productId} {INBOX_COPY.ends}{" "}
                                                                <Time
                                                                    at={item.endsAt}
                                                                    format="date"
                                                                />
                                                            </Link>
                                                        );
                                                    case "ticket_reply":
                                                        return (
                                                            <Link
                                                                to="/support/$ticketId"
                                                                params={{ ticketId: item.ticketId }}
                                                                className={styles.link}
                                                            >
                                                                {INBOX_COPY.ticketReply}
                                                            </Link>
                                                        );
                                                }
                                            })()}
                                            value={<Time at={item.createdAt} format="relative" />}
                                            action={
                                                item.isRead ? (
                                                    <Note>{INBOX_COPY.read}</Note>
                                                ) : (
                                                    <RowAction
                                                        tone="pink"
                                                        pending={marking === item.id}
                                                        onClick={() => void mark(item.id)}
                                                    >
                                                        {INBOX_COPY.mark}
                                                    </RowAction>
                                                )
                                            }
                                        />
                                    ))}
                                </SettingRows>
                                <Pager
                                    nextCursor={outcome.value.nextCursor}
                                    onNext={(cursor) =>
                                        void router.navigate({
                                            to: "/account/inbox",
                                            search: { cursor },
                                        })
                                    }
                                />
                            </>
                        )}
                    </>
                }
            />
        </Page>
    );
}
