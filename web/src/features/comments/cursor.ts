import { inboxSearch } from "../../search.ts";

// Community lists page by the id of the last row seen, the same ?cursor= the inbox reads. Routes
// share this one reader and one loader-deps shape.
export const cursorSearch = inboxSearch;

export const cursorDeps = ({
    search,
}: {
    readonly search: { readonly cursor?: string | undefined };
}) => ({
    cursor: search.cursor ?? null,
});
