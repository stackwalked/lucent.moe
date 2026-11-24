import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { TICKETS_COPY, TICKETS_TITLE } from "./copy.ts";
import { closeTicket, setConfigConsent, writeTicket } from "./server.ts";
import { Reply, Thread } from "./Thread.tsx";

const route = getRouteApi("/_member/tickets/$ticketId");

// One of the member's tickets: the thread, a reply, closing it, and whether staff may read the
// member's configs for it.
export function TicketPage() {
    const { ticketId } = route.useParams();
    const ticket = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const act = async (run: () => Promise<Outcome<null>>) => {
        const reply = await run();
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const back = <Link to="/tickets">{TICKETS_COPY.back}</Link>;
    if (!ticket.ok) {
        return (
            <Page title={TICKETS_TITLE} trail={back}>
                <RefusalNote refused={ticket.refused} />
            </Page>
        );
    }
    const { value } = ticket;
    const closed = value.state === "closed";
    const granted = !closed && value.configConsent?.granted === true;
    return (
        <Page
            title={value.subject}
            trail={back}
            actions={
                closed ? null : (
                    <Button
                        size="sm"
                        onClick={() => void act(() => closeTicket({ data: { ticketId } }))}
                    >
                        {TICKETS_COPY.close}
                    </Button>
                )
            }
        >
            <Stack gap={6}>
                <Status tone={value.state === "answered" ? "pink" : "neutral"}>
                    {TICKETS_COPY.states[value.state]}
                </Status>
                <RefusalNote refused={refused} />
                <Thread caption={value.subject} messages={value.messages} />
                <Reply
                    label={TICKETS_COPY.body}
                    submitLabel={TICKETS_COPY.reply}
                    {...(closed ? { hint: TICKETS_COPY.replyHint } : {})}
                    send={(body) => writeTicket({ data: { ticketId, body } })}
                />
                {closed ? null : (
                    <Section caption={TICKETS_COPY.consent}>
                        <Stack direction="row" gap={3} align="center">
                            <p>
                                {granted ? TICKETS_COPY.consentGranted : TICKETS_COPY.consentNone}
                            </p>
                            <Button
                                size="sm"
                                onClick={() =>
                                    void act(() =>
                                        setConfigConsent({ data: { ticketId, granted: !granted } }),
                                    )
                                }
                            >
                                {granted ? TICKETS_COPY.withdraw : TICKETS_COPY.allow}
                            </Button>
                        </Stack>
                    </Section>
                )}
            </Stack>
        </Page>
    );
}
