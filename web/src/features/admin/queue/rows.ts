import type { Outcome } from "../../../server/outcome.ts";
import { QUEUE_COPY as C } from "./copy.ts";
import type { QueueRow } from "./merge.ts";
import type { Queue } from "./server.ts";

type Value<K extends keyof Queue> = Queue[K] extends Outcome<infer T> | null ? T : never;

// Each read's rows as queue rows: a title, a line of context, who it concerns, since when.
export function ticketRows(
    read: Value<"tickets">,
    nameOf: (productId: string) => string,
): QueueRow[] {
    return read.items.map((ticket) => ({
        kind: "tickets",
        id: ticket.id,
        title: ticket.subject ?? (ticket.kind === "appeal" ? C.appeal : C.helpTicket),
        context:
            ticket.kind === "appeal"
                ? C.appeal
                : ticket.productId === null
                  ? C.noProduct
                  : nameOf(ticket.productId),
        who: { accountId: ticket.account.id, username: ticket.account.username },
        at: ticket.lastActivityAt,
    }));
}

export function applicationRows(read: Value<"applications">): QueueRow[] {
    return read.items.map((item) => ({
        kind: "applications",
        id: item.applicationId,
        title: item.email,
        context: item.games,
        who: null,
        at: item.createdAt,
    }));
}

export function reportRows(read: Value<"reports">): QueueRow[] {
    return read.items.map((item) => ({
        kind: "reports",
        id: item.id,
        title: item.excerpt,
        context:
            item.note === "" ? C.reason(item.reason) : `${C.reason(item.reason)}: ${item.note}`,
        who: { accountId: item.author.accountId, username: item.author.username },
        at: item.createdAt,
    }));
}

export function flagRows(read: Value<"flags">): QueueRow[] {
    return read.items.map((item) => ({
        kind: "flags",
        id: item.id,
        title: C.flagTitle(item.risk),
        context: item.signals.map((signal) => signal.kind).join(", "),
        who: { accountId: item.account.id, username: item.account.username },
        at: item.openedAt,
    }));
}

export function listingRows(
    read: Value<"listings">,
    nameOf: (productId: string) => string,
): QueueRow[] {
    return read.items.map((item) => ({
        kind: "listings",
        id: item.id,
        title: item.name,
        context: `${item.kind} · ${nameOf(item.productId)} · ${item.first ? C.first : C.update}`,
        who: { accountId: item.owner.accountId, username: item.owner.username },
        at: item.updatedAt,
    }));
}
