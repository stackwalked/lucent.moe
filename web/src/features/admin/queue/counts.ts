import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { countWord, QUEUE_KINDS, type QueueKind } from "./merge.ts";
import { fetchQueueFirst } from "./server.ts";

type Extent = "all" | "partial";
type Held = { readonly loaded: number; readonly extent: Extent };

const byCursor = (items: readonly unknown[], next: string | null): Held => ({
    loaded: items.length,
    extent: next === null ? "all" : "partial",
});
const byCut = (items: readonly unknown[], extent: Extent): Held => ({
    loaded: items.length,
    extent,
});

// How many wait in each kind, for the bar and the queue's sub-tabs: what the first page of each
// read holds, with a plus where the read has more or was cut short. A kind with nothing waiting
// or not readable has no entry.
export const fetchQueueCounts = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ kinds: z.array(z.enum(QUEUE_KINDS)) }).parse(data),
    )
    .handler(async ({ data }) => {
        const queue = await fetchQueueFirst({ data });
        const held: Partial<Record<QueueKind, Held>> = {};
        if (queue.tickets?.ok)
            held.tickets = byCursor(queue.tickets.value.items, queue.tickets.value.nextCursor);
        if (queue.applications?.ok)
            held.applications = byCut(
                queue.applications.value.items,
                queue.applications.value.truncated ? "partial" : "all",
            );
        if (queue.reports?.ok)
            held.reports = byCursor(queue.reports.value.items, queue.reports.value.nextCursor);
        if (queue.flags?.ok)
            held.flags = byCut(
                queue.flags.value.items,
                queue.flags.value.truncated ? "partial" : "all",
            );
        if (queue.listings?.ok)
            held.listings = byCursor(queue.listings.value.items, queue.listings.value.nextCursor);

        const counts: Partial<Record<QueueKind, string>> = {};
        let sum = 0;
        let partial = false;
        for (const kind of QUEUE_KINDS) {
            const entry = held[kind];
            if (entry === undefined) continue;
            sum += entry.loaded;
            if (entry.extent === "partial") partial = true;
            if (entry.loaded > 0) counts[kind] = countWord(entry.loaded, entry.extent);
        }
        return {
            counts,
            total: sum === 0 ? null : countWord(sum, partial ? "partial" : "all"),
        };
    });
