import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useActionState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pager } from "../../ui/Pager/Pager.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { ProductSelect } from "../products/ProductSelect.tsx";
import { productName } from "../products/view.ts";
import { TICKETS_COPY, TICKETS_TITLE } from "./copy.ts";
import { openTicket } from "./server.ts";

const route = getRouteApi("/_member/tickets/");

type Product = { readonly productId: string; readonly name: string };

// The member's help tickets and the form that opens one. A ticket may name one of the products
// the member can see.
export function TicketsPage() {
    const { tickets, products } = route.useLoaderData();
    const router = useRouter();
    const nameOf = (productId: string) => {
        const product = products.ok
            ? products.value.find((p) => p.productId === productId)
            : undefined;
        return product === undefined ? productId : productName(product.name);
    };
    return (
        <Page title={TICKETS_TITLE}>
            <Stack gap={6}>
                <OpenTicket products={products.ok ? products.value : []} />
                <Section caption={TICKETS_COPY.list}>
                    {!tickets.ok ? (
                        <RefusalNote refused={tickets.refused} />
                    ) : tickets.value.items.length === 0 ? (
                        <Empty>{TICKETS_COPY.none}</Empty>
                    ) : (
                        <Stack gap={2}>
                            <Table
                                caption={TICKETS_COPY.list}
                                rows={tickets.value.items}
                                rowKey={(ticket) => ticket.id}
                                columns={[
                                    {
                                        key: "subject",
                                        header: TICKETS_COPY.subject,
                                        cell: (ticket) => (
                                            <Link
                                                to="/tickets/$ticketId"
                                                params={{ ticketId: ticket.id }}
                                            >
                                                {ticket.subject}
                                            </Link>
                                        ),
                                    },
                                    {
                                        key: "product",
                                        header: TICKETS_COPY.product,
                                        cell: (ticket) =>
                                            ticket.productId === null
                                                ? TICKETS_COPY.noProduct
                                                : nameOf(ticket.productId),
                                    },
                                    {
                                        key: "state",
                                        header: TICKETS_COPY.state,
                                        cell: (ticket) => TICKETS_COPY.states[ticket.state],
                                    },
                                    {
                                        key: "activity",
                                        header: TICKETS_COPY.lastActivity,
                                        cell: (ticket) => (
                                            <Time at={ticket.lastActivityAt} format="relative" />
                                        ),
                                    },
                                ]}
                            />
                            <Pager
                                nextCursor={tickets.value.nextCursor}
                                onNext={(cursor) =>
                                    void router.navigate({ to: "/tickets", search: { cursor } })
                                }
                            />
                            <p>{TICKETS_COPY.idle}</p>
                        </Stack>
                    )}
                </Section>
            </Stack>
        </Page>
    );
}

function OpenTicket({ products }: { readonly products: readonly Product[] }) {
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
            await router.navigate({ to: "/tickets/$ticketId", params: { ticketId: reply.value } });
            return null;
        },
        null,
    );
    return (
        <Section caption={TICKETS_COPY.open}>
            <form action={submit}>
                <Stack gap={3}>
                    <p>{TICKETS_COPY.openHint}</p>
                    <TextField
                        name="subject"
                        label={TICKETS_COPY.subject}
                        required
                        maxLength={120}
                    />
                    <ProductSelect
                        name="productId"
                        label={TICKETS_COPY.product}
                        none={TICKETS_COPY.noProduct}
                        products={products}
                    />
                    <TextArea name="body" label={TICKETS_COPY.body} maxLength={4000} required />
                    <RefusalNote refused={refused} />
                    <div>
                        <Button type="submit" pending={pending}>
                            {TICKETS_COPY.send}
                        </Button>
                    </div>
                </Stack>
            </form>
        </Section>
    );
}
