import { MessageBody, TicketId, TicketState } from "@lucent/rpc/web/tickets";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

export const listTickets = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ state: TicketState, cursor: TicketId.nullable() }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.tickets.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const fetchStaffTicket = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ ticketId: TicketId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.tickets.get", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const answerTicket = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ ticketId: TicketId, body: MessageBody }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.tickets.reply", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const closeStaffTicket = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ ticketId: TicketId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.tickets.close", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
