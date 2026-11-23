import { z } from "zod";

// Community lists page by the id of the last row seen. Routes share this one schema and one
// loader-deps shape so each route adds as little as possible to the entry bundle.
export const cursorSearch = z.object({ cursor: z.uuid().optional() });

export const cursorDeps = ({
    search,
}: {
    readonly search: { readonly cursor?: string | undefined };
}) => ({
    cursor: search.cursor ?? null,
});
