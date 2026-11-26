import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, type Outcome, refuse } from "../../../server/outcome.ts";
import { callPlatform } from "../../../server/platform.ts";
import { QUEUE_KINDS } from "./merge.ts";

const Cursors = z.strictObject({
    tickets: z.string().nullable(),
    reports: z.string().nullable(),
    listings: z.string().nullable(),
});

const NO_CURSORS = { tickets: null, reports: null, listings: null };

async function reads(
    kinds: readonly (typeof QUEUE_KINDS)[number][],
    cursors: z.output<typeof Cursors>,
) {
    const want = (kind: (typeof QUEUE_KINDS)[number]) => kinds.includes(kind);
    const [tickets, applications, reports, flags, listings] = await Promise.all([
        want("tickets")
            ? callPlatform("admin.tickets.list", { state: "open", cursor: cursors.tickets })
            : null,
        want("applications") ? callPlatform("admin.applications.list", { state: "pending" }) : null,
        want("reports")
            ? callPlatform("admin.moderation.reports.list", { cursor: cursors.reports })
            : null,
        want("flags") ? callPlatform("admin.review.list", { state: "open" }) : null,
        want("listings")
            ? callPlatform("admin.cloud.listings.list", {
                  state: "pending",
                  cursor: cursors.listings,
              })
            : null,
    ]);
    return {
        tickets: tickets === null ? null : tickets.ok ? done(tickets.value) : refuse(tickets.error),
        applications:
            applications === null
                ? null
                : applications.ok
                  ? done(applications.value)
                  : refuse(applications.error),
        reports: reports === null ? null : reports.ok ? done(reports.value) : refuse(reports.error),
        flags: flags === null ? null : flags.ok ? done(flags.value) : refuse(flags.error),
        listings:
            listings === null ? null : listings.ok ? done(listings.value) : refuse(listings.error),
    };
}

// What waits for staff, one page of each read the viewer may use. A read that is refused (or
// not asked for) is left out of the list rather than failing the page.
export const fetchQueue = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ kinds: z.array(z.enum(QUEUE_KINDS)), cursors: Cursors }).parse(data),
    )
    .handler(async ({ data }) => await reads(data.kinds, data.cursors));

export const fetchQueueFirst = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ kinds: z.array(z.enum(QUEUE_KINDS)) }).parse(data),
    )
    .handler(async ({ data }) => await reads(data.kinds, NO_CURSORS));

export type Queue = Awaited<ReturnType<typeof reads>>;
export type { Outcome };
