import { optional, searchSchema } from "../../../search.ts";

type View = "reports" | "restrictions";

const isView = (value: unknown): value is View => value === "reports" || value === "restrictions";

// ?view=: the reports queue (the default) or the active restrictions.
export const moderationSearch = searchSchema((search) => optional(search, "view", isView));
