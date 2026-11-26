import { getRouteApi, Link } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pager } from "../../../ui/Pager/Pager.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { productNamer } from "../../products/view.ts";
import { ADMIN_COPY } from "../copy.ts";
import { useListNavigation } from "../list.ts";
import { STAFF_TICKETS_COPY, STAFF_TICKETS_TITLE } from "./copy.ts";
import type { TicketView } from "./search.ts";

const route = getRouteApi("/_admin/admin/tickets/");

const VIEWS: readonly TicketView[] = ["open", "answered", "closed"];

// Help tickets and appeals as staff work them: those waiting on staff longest first, then those
// waiting on the member, then the closed ones.
export function StaffTicketsPage() {
    const { view, outcome, catalog } = route.useLoaderData();
    const nameOf = productNamer(catalog);
    const navigation = useListNavigation();
    return (
        <Page
            title={STAFF_TICKETS_TITLE}
            actions={
                <Stack direction="row" gap={3}>
                    {VIEWS.filter((other) => other !== view).map((other) => (
                        <Link key={other} to="/admin/tickets" search={{ state: other }}>
                            {STAFF_TICKETS_COPY.views[other]}
                        </Link>
                    ))}
                </Stack>
            }
        >
            {!outcome.ok ? (
                <RefusalNote refused={outcome.refused} />
            ) : outcome.value.items.length === 0 ? (
                <Empty>{STAFF_TICKETS_COPY.none[view]}</Empty>
            ) : (
                <Stack gap={2}>
                    <Table
                        caption={STAFF_TICKETS_COPY.views[view]}
                        rows={outcome.value.items}
                        rowKey={(ticket) => ticket.id}
                        columns={[
                            {
                                key: "subject",
                                header: STAFF_TICKETS_COPY.subject,
                                cell: (ticket) => (
                                    <Link
                                        to="/admin/tickets/$ticketId"
                                        params={{ ticketId: ticket.id }}
                                    >
                                        {ticket.subject ?? STAFF_TICKETS_COPY.appeal}
                                    </Link>
                                ),
                            },
                            {
                                key: "account",
                                header: STAFF_TICKETS_COPY.account,
                                cell: (ticket) => (
                                    <Who
                                        accountId={ticket.account.id}
                                        username={ticket.account.username}
                                        pending={ADMIN_COPY.pending}
                                    />
                                ),
                            },
                            {
                                key: "product",
                                header: STAFF_TICKETS_COPY.product,
                                cell: (ticket) =>
                                    ticket.productId === null
                                        ? STAFF_TICKETS_COPY.noProduct
                                        : nameOf(ticket.productId),
                            },
                            {
                                key: "activity",
                                header:
                                    view === "open"
                                        ? STAFF_TICKETS_COPY.waiting
                                        : STAFF_TICKETS_COPY.lastActivity,
                                cell: (ticket) => (
                                    <Time at={ticket.lastActivityAt} format="relative" />
                                ),
                            },
                        ]}
                    />
                    <Pager
                        nextCursor={outcome.value.nextCursor}
                        onNext={(cursor) => void navigation.next(cursor)}
                    />
                </Stack>
            )}
        </Page>
    );
}
