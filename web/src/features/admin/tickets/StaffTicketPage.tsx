import { getRouteApi, Link } from "@tanstack/react-router";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pairs } from "../../../ui/Pairs/Pairs.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { Reply, Thread, type ThreadMessage } from "../../comments/Thread.tsx";
import { productNamer } from "../../products/view.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { STAFF_TICKETS_COPY, STAFF_TICKETS_TITLE } from "./copy.ts";
import { answerTicket, closeStaffTicket } from "./server.ts";

const route = getRouteApi("/_admin/admin/queue/tickets/$ticketId");

// One ticket or appeal as staff answer it. An appeal shows the suspension as staff recorded it;
// reinstating is the account page's own action.
export function StaffTicketPage() {
    const { ticketId } = route.useParams();
    const { ticket, catalog } = route.useLoaderData();
    const nameOf = productNamer(catalog);
    const back = <Link to="/admin/queue/tickets">{STAFF_TICKETS_COPY.back}</Link>;
    if (!ticket.ok) {
        return (
            <Page title={STAFF_TICKETS_TITLE} trail={back}>
                <RefusalNote refused={ticket.refused} />
            </Page>
        );
    }
    const { value } = ticket;
    const closed = value.state === "closed";
    const authors = new Map(value.messages.map((m) => [m.id, m.author]));
    const authorOf = (message: ThreadMessage) => {
        const author = authors.get(message.id);
        return author?.username ?? author?.id ?? ADMIN_COPY.pending;
    };
    return (
        <Page
            title={
                value.subject ??
                (value.kind === "appeal" ? STAFF_TICKETS_COPY.appeal : STAFF_TICKETS_COPY.help)
            }
            trail={back}
            actions={
                closed ? null : (
                    <AccountAction
                        action="tickets:reply"
                        label={STAFF_TICKETS_COPY.close}
                        title={STAFF_TICKETS_COPY.closeTitle}
                        fields={<p>{STAFF_TICKETS_COPY.closeBody}</p>}
                        run={() => closeStaffTicket({ data: { ticketId } })}
                    />
                )
            }
        >
            <Stack gap={6}>
                <Pairs
                    items={[
                        {
                            label: STAFF_TICKETS_COPY.member,
                            value: (
                                <Who
                                    accountId={value.account.id}
                                    username={value.account.username}
                                    pending={ADMIN_COPY.pending}
                                />
                            ),
                        },
                        {
                            label: STAFF_TICKETS_COPY.state,
                            value: (
                                <Status tone={value.state === "open" ? "pink" : "neutral"}>
                                    {STAFF_TICKETS_COPY.states[value.state]}
                                </Status>
                            ),
                        },
                        {
                            label: STAFF_TICKETS_COPY.product,
                            value:
                                value.productId === null
                                    ? STAFF_TICKETS_COPY.noProduct
                                    : nameOf(value.productId),
                        },
                        {
                            label: STAFF_TICKETS_COPY.configs,
                            value: value.configReadable
                                ? STAFF_TICKETS_COPY.configsReadable
                                : STAFF_TICKETS_COPY.configsClosed,
                        },
                    ]}
                />
                {value.accountStatus === "deleted" ? (
                    <p>{STAFF_TICKETS_COPY.ownerDeleted}</p>
                ) : null}
                {value.kind === "appeal" ? (
                    <Section caption={STAFF_TICKETS_COPY.appeal}>
                        <Stack gap={2}>
                            {value.accountStatus === "suspended" ? (
                                <p>{STAFF_TICKETS_COPY.suspended}</p>
                            ) : null}
                            <Pairs
                                items={[
                                    {
                                        label: STAFF_TICKETS_COPY.reason,
                                        value:
                                            value.suspension === null ? (
                                                STAFF_TICKETS_COPY.noReason
                                            ) : (
                                                <>
                                                    {value.suspension.reason}{" "}
                                                    <Time at={value.suspension.at} />
                                                </>
                                            ),
                                    },
                                ]}
                            />
                            <Link
                                to="/admin/members/accounts/$accountId"
                                params={{ accountId: value.account.id }}
                            >
                                {STAFF_TICKETS_COPY.reinstate}
                            </Link>
                        </Stack>
                    </Section>
                ) : null}
                <Thread
                    caption={
                        value.subject ??
                        (value.kind === "appeal"
                            ? STAFF_TICKETS_COPY.appeal
                            : STAFF_TICKETS_COPY.help)
                    }
                    messages={value.messages}
                    authorOf={authorOf}
                />
                {closed ? null : (
                    <Reply
                        label={STAFF_TICKETS_COPY.replyLabel}
                        submitLabel={STAFF_TICKETS_COPY.reply}
                        send={(body) => answerTicket({ data: { ticketId, body } })}
                    />
                )}
            </Stack>
        </Page>
    );
}
