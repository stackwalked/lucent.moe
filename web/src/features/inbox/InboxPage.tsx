import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pager } from "../../ui/Pager/Pager.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PREFERENCES_TITLE } from "../preferences/copy.ts";
import { INBOX_COPY, INBOX_TITLE } from "./copy.ts";
import { markInboxRead } from "./server.ts";

const route = getRouteApi("/_member/account/inbox");

export function InboxPage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const mark = async (id: string) => {
        const reply = await markInboxRead({ data: { id } });
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    return (
        <Page
            title={INBOX_TITLE}
            actions={<Link to="/account/preferences">{PREFERENCES_TITLE}</Link>}
        >
            <RefusalNote refused={outcome.ok ? refused : outcome.refused} />
            {!outcome.ok ? null : outcome.value.items.length === 0 ? (
                <Empty>{INBOX_COPY.empty}</Empty>
            ) : (
                <>
                    <Table
                        caption={INBOX_TITLE}
                        rows={outcome.value.items}
                        rowKey={(item) => item.id}
                        columns={[
                            {
                                key: "time",
                                header: INBOX_COPY.time,
                                cell: (item) => <Time at={item.createdAt} />,
                            },
                            {
                                key: "kind",
                                header: INBOX_COPY.notification,
                                cell: (item) => {
                                    switch (item.kind) {
                                        case "security":
                                            return INBOX_COPY.security;
                                        case "product_status":
                                            return INBOX_COPY.product(item.productId);
                                        case "ticket_reply":
                                            return (
                                                <Link
                                                    to="/support/$ticketId"
                                                    params={{ ticketId: item.ticketId }}
                                                >
                                                    {INBOX_COPY.ticketReply}
                                                </Link>
                                            );
                                    }
                                },
                            },
                            {
                                key: "status",
                                header: INBOX_COPY.status,
                                cell: (item) =>
                                    item.isRead ? (
                                        INBOX_COPY.read
                                    ) : (
                                        <Button size="sm" onClick={() => void mark(item.id)}>
                                            {INBOX_COPY.mark}
                                        </Button>
                                    ),
                            },
                        ]}
                    />
                    <Pager
                        nextCursor={outcome.value.nextCursor}
                        onNext={(cursor) =>
                            void router.navigate({ to: "/account/inbox", search: { cursor } })
                        }
                    />
                </>
            )}
        </Page>
    );
}
