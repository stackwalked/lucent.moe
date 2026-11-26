import type { EpochMs } from "@lucent/core/scalars";
import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { useActionState, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { memberOf, type Viewer } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { ProductSelect } from "../products/ProductSelect.tsx";
import { productName } from "../products/view.ts";
import { SUPPORT_COPY as C, SUPPORT_TITLE } from "./copy.ts";
import styles from "./SupportPage.module.css";
import { closeTicket, fetchTickets, openTicket, setConfigConsent, writeTicket } from "./server.ts";

type ListPage = Extract<Awaited<ReturnType<typeof fetchTickets>>, { readonly ok: true }>["value"];
export type TicketSummary = ListPage["items"][number];
type TicketDetail = Extract<
    Awaited<ReturnType<typeof import("./server.ts").fetchTicket>>,
    { readonly ok: true }
>["value"];

export type SupportData = {
    readonly tickets: Outcome<ListPage>;
    readonly products: Outcome<readonly { readonly productId: string; readonly name: string }[]>;
    // The ticket the left side shows; null is the new-ticket form.
    readonly shown: Outcome<TicketDetail> | null;
};

const toneOf = (state: TicketSummary["state"]): "ink" | "wait" | "dim" =>
    state === "open" ? "ink" : state === "answered" ? "wait" : "dim";

// Support as one page: the conversation (or the form that starts one) on the left, the member's
// tickets on the right. Both /support routes render this; their loaders decide which ticket the
// left side holds. The title stays for screen readers only — the columns' own head rows are the
// page's first hairlines.
export function SupportPage({ data }: { readonly data: SupportData }) {
    const { tickets, products, shown } = data;
    const context = useRouteContext({ from: "__root__" });
    const viewer = memberOf(context.session);
    const nameOf = (productId: string) => {
        const product = products.ok
            ? products.value.find((p) => p.productId === productId)
            : undefined;
        return product === undefined ? productId : productName(product.name);
    };
    const detail = shown?.ok ? shown.value : null;
    return (
        <Page title={SUPPORT_TITLE} hideTitle width="wide">
            <Columns
                main={
                    shown === null ? (
                        <NewTicket products={products.ok ? products.value : []} />
                    ) : shown.ok ? (
                        <TicketView
                            ticket={shown.value}
                            viewer={viewer}
                            avatar={context.avatar}
                            nameOf={nameOf}
                        />
                    ) : (
                        <RefusalNote refused={shown.refused} />
                    )
                }
                aside={
                    <Stack gap={6}>
                        <YourTickets first={tickets} shownId={detail?.id ?? null} nameOf={nameOf} />
                        {detail === null || detail.state === "closed" ? null : (
                            <ConfigConsent
                                ticketId={detail.id}
                                granted={detail.configConsent?.granted === true}
                            />
                        )}
                    </Stack>
                }
            />
        </Page>
    );
}

// One message in the thread: the member's own picture and name, or nothing and the single word
// "staff" — members never learn which staff account answered.
function MessageRow({
    message,
    viewer,
    avatar,
}: {
    readonly message: {
        readonly id: string;
        readonly fromStaff: boolean;
        readonly body: string;
        readonly at: EpochMs;
    };
    readonly viewer: Viewer | null;
    readonly avatar: string | null;
}) {
    const staff = message.fromStaff;
    return (
        <article className={styles.message}>
            <span className={styles.avatarBox}>
                {staff ? null : <Avatar digest={avatar} size="small" />}
            </span>
            <div>
                <div className={styles.who}>
                    <span className={styles.name} data-staff={staff}>
                        {staff ? C.staff : (viewer?.username ?? C.you)}
                    </span>
                    <span className={styles.when}>
                        <Time at={message.at} />
                    </span>
                </div>
                <p className={styles.msgBody}>{message.body}</p>
            </div>
        </article>
    );
}

function TicketView({
    ticket,
    viewer,
    avatar,
    nameOf,
}: {
    readonly ticket: TicketDetail;
    readonly viewer: Viewer | null;
    readonly avatar: string | null;
    readonly nameOf: (productId: string) => string;
}) {
    return (
        <>
            <header className={styles.head}>
                <h2 className={styles.subject}>{ticket.subject}</h2>
                <span className={styles.headEnd}>
                    {ticket.productId === null ? null : <>{nameOf(ticket.productId)} · </>}
                    <span className={styles.word} data-tone={toneOf(ticket.state)}>
                        {C.states[ticket.state]}
                    </span>
                </span>
            </header>
            <div className={styles.messages}>
                {ticket.messages.map((message) => (
                    <MessageRow
                        key={message.id}
                        message={message}
                        viewer={viewer}
                        avatar={avatar}
                    />
                ))}
            </div>
            {ticket.state === "closed" ? null : <ReplyForm ticketId={ticket.id} />}
        </>
    );
}

function ReplyForm({ ticketId }: { readonly ticketId: string }) {
    const router = useRouter();
    const [refused, submit, pending] = useActionState(
        async (_: Refused | null, form: FormData): Promise<Refused | null> => {
            const reply = await writeTicket({
                data: { ticketId, body: String(form.get("body") ?? "") },
            });
            if (!reply.ok) return reply.refused;
            await router.invalidate();
            return null;
        },
        null,
    );
    const [closeRefusal, setCloseRefusal] = useState<Refused | null>(null);
    const [closing, setClosing] = useState(false);
    return (
        <form action={submit}>
            <Stack gap={3}>
                <TextArea name="body" label={C.reply} maxLength={4000} required />
                <RefusalNote refused={refused ?? closeRefusal} />
                <div className={styles.replyActs}>
                    <Button type="submit" tone="pink" pending={pending}>
                        {C.send}
                    </Button>
                    <Button
                        type="button"
                        pending={closing}
                        onClick={async () => {
                            setClosing(true);
                            const reply = await closeTicket({ data: { ticketId } });
                            setClosing(false);
                            setCloseRefusal(reply.ok ? null : reply.refused);
                            if (reply.ok) await router.invalidate();
                        }}
                    >
                        {C.close}
                    </Button>
                </div>
            </Stack>
        </form>
    );
}

function NewTicket({
    products,
}: {
    readonly products: readonly { readonly productId: string; readonly name: string }[];
}) {
    const router = useRouter();
    const [refused, submit, pending] = useActionState(
        async (_: Refused | null, form: FormData): Promise<Refused | null> => {
            const product = String(form.get("productId") ?? "");
            const reply = await openTicket({
                data: {
                    productId: product === "" ? null : product,
                    subject: String(form.get("subject") ?? ""),
                    body: String(form.get("body") ?? ""),
                },
            });
            if (!reply.ok) return reply.refused;
            await router.navigate({ to: "/support/$ticketId", params: { ticketId: reply.value } });
            return null;
        },
        null,
    );
    return (
        <Section caption={C.newTicket}>
            <form action={submit}>
                <Stack gap={3}>
                    <TextField name="subject" label={C.subject} required maxLength={120} />
                    <ProductSelect
                        name="productId"
                        label={C.product}
                        none={C.noProduct}
                        products={products}
                    />
                    <TextArea name="body" label={C.body} maxLength={4000} required />
                    <RefusalNote refused={refused} />
                    <div>
                        <Button type="submit" tone="pink" pending={pending}>
                            {C.send}
                        </Button>
                    </div>
                </Stack>
            </form>
        </Section>
    );
}

// The member's tickets, latest activity first: subject linking to the ticket, product and date
// under it in small ink-2, the state word at the row's end, the shown one's subject in pink.
// "more" appends the next page client-side; the address never gains a cursor.
function YourTickets({
    first,
    shownId,
    nameOf,
}: {
    readonly first: Outcome<ListPage>;
    readonly shownId: string | null;
    readonly nameOf: (productId: string) => string;
}) {
    const [extra, setExtra] = useState<readonly (readonly TicketSummary[])[]>([]);
    const [next, setNext] = useState<string | null>(first.ok ? first.value.nextCursor : null);
    const [pending, setPending] = useState(false);
    const items = [...(first.ok ? first.value.items : []), ...extra.flat()];
    return (
        <Section
            caption={C.list}
            actions={
                <Link to="/support" search={{ new: "true" }}>
                    {C.newTicket}
                </Link>
            }
        >
            {!first.ok ? (
                <RefusalNote refused={first.refused} />
            ) : items.length === 0 ? (
                <Empty>{C.none}</Empty>
            ) : (
                <div>
                    {items.map((ticket) => (
                        <Link
                            key={ticket.id}
                            to="/support/$ticketId"
                            params={{ ticketId: ticket.id }}
                            className={styles.ticket}
                            aria-current={ticket.id === shownId ? "page" : undefined}
                        >
                            <span className={styles.ticketSubject}>{ticket.subject}</span>
                            <span className={styles.ticketState} data-tone={toneOf(ticket.state)}>
                                {C.states[ticket.state]}
                            </span>
                            <span className={styles.ticketMeta}>
                                {ticket.productId === null
                                    ? null
                                    : `${nameOf(ticket.productId)} · `}
                                <Time at={ticket.lastActivityAt} format="date" />
                            </span>
                        </Link>
                    ))}
                </div>
            )}
            {next === null ? null : (
                <div className={styles.moreRow}>
                    <Button
                        type="button"
                        tone="plain"
                        pending={pending}
                        onClick={async () => {
                            if (next === null) return;
                            setPending(true);
                            const more = await fetchTickets({ data: { cursor: next } });
                            setPending(false);
                            if (!more.ok) return;
                            setExtra((soFar) => [...soFar, more.value.items]);
                            setNext(more.value.nextCursor);
                        }}
                    >
                        {C.more}
                    </Button>
                </div>
            )}
        </Section>
    );
}

// Whether staff may read the member's configs for the shown ticket, unchanged from the old
// ticket page, now the right column's second block.
function ConfigConsent({
    ticketId,
    granted,
}: {
    readonly ticketId: string;
    readonly granted: boolean;
}) {
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const [pending, setPending] = useState(false);
    return (
        <Section caption={C.consent}>
            <Stack direction="row" gap={3} align="center">
                <p>{granted ? C.consentGranted : C.consentNone}</p>
                <Button
                    size="sm"
                    pending={pending}
                    onClick={async () => {
                        setPending(true);
                        const reply = await setConfigConsent({
                            data: { ticketId, granted: !granted },
                        });
                        setPending(false);
                        setRefused(reply.ok ? null : reply.refused);
                        if (reply.ok) await router.invalidate();
                    }}
                >
                    {granted ? C.withdraw : C.allow}
                </Button>
            </Stack>
            <RefusalNote refused={refused} />
        </Section>
    );
}
