import { optional, searchSchema } from "../../../search.ts";

// Where a detail page was opened from: the queue's "all" or one of its lists. The back link
// returns there.
export const FROM = ["all", "tickets", "applications", "reports", "flags"] as const;
export type From = (typeof FROM)[number];

const isFrom = (value: unknown): value is From => FROM.some((from) => from === value);

export const fromSearch = searchSchema((search) => optional(search, "from", isFrom));

export const FROM_PATHS = {
    all: "/admin",
    tickets: "/admin/queue/tickets",
    applications: "/admin/queue/applications",
    reports: "/admin/queue/reports",
    flags: "/admin/queue/flags",
} as const satisfies Record<From, string>;
