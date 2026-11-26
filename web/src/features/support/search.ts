import { searchSchema } from "../../search.ts";

// /support's ?new=true: with it the left side is the new-ticket form even while a ticket is
// open. A string, as every search value here is: booleans don't survive the router's own
// serialization.
export const supportSearch = searchSchema<{ readonly new?: "true" }, { readonly new?: string }>(
    (search) => {
        const value = search["new"];
        if (value === undefined) return {};
        return value === "true" || value === true ? { new: "true" as const } : null;
    },
);
