import { optional, searchSchema } from "../../search.ts";

const FIND_MAX = 64;

const isFind = (value: unknown): value is string =>
    typeof value === "string" && value.length >= 1 && value.length <= FIND_MAX;

// /community's ?find=: a username prefix. Empty is no search, so it is left out of the address
// rather than refused.
export const communitySearch = searchSchema<{ readonly find?: string }, { readonly find?: string }>(
    (search) => optional(search, "find", isFind),
);
