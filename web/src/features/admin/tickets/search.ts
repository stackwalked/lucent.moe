import { optional, searchSchema } from "../../../search.ts";

export type TicketView = "open" | "answered" | "closed";

const isView = (value: unknown): value is TicketView =>
    value === "open" || value === "answered" || value === "closed";

// ?state=: the tickets waiting on staff (the default), waiting on the member, or closed.
export const ticketsSearch = searchSchema((search) => optional(search, "state", isView));
