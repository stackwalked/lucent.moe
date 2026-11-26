import { ProductId } from "@lucent/core/scalars";
import { MessageBody, TicketId, TicketSubject } from "@lucent/rpc/web/tickets";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchTickets = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ cursor: TicketId.nullable() }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("tickets.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const fetchTicket = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ ticketId: TicketId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("tickets.get", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const openTicket = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({
                productId: ProductId.nullable(),
                subject: TicketSubject,
                body: MessageBody,
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("tickets.open", data);
        return reply.ok ? done(reply.value.ticketId) : refuse(reply.error);
    });

export const writeTicket = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ ticketId: TicketId, body: MessageBody }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("tickets.messages.send", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const closeTicket = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ ticketId: TicketId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("tickets.close", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const setConfigConsent = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ ticketId: TicketId, granted: z.boolean() }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("tickets.consent.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
