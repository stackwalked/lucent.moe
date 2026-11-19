import { type ParsedLocation, useRouter } from "@tanstack/react-router";

// Admin lists keep their filter in ?q= and their page and sort in history.state: a loader reads
// both from its location, and moving on pushes a history entry, so Back returns to the page before.

export function listState(location: ParsedLocation): {
    readonly cursor: string | null;
    readonly sort: string | null;
} {
    return { cursor: location.state.cursor ?? null, sort: location.state.sort ?? null };
}

export function useListNavigation() {
    const router = useRouter();
    const here = () => router.state.location;
    return {
        // The next page: same filter and sort, the cursor platform handed out.
        next: (cursor: string) =>
            router.navigate({
                to: here().pathname,
                search: here().search,
                state: { ...here().state, cursor },
            }),
        // Back to the first page, as it is now: same filter and sort.
        first: () => {
            const { sort } = here().state;
            return router.navigate({
                to: here().pathname,
                search: here().search,
                state: sort === undefined ? {} : { sort },
            });
        },
        // A different sort starts from the first page.
        sort: (sort: string) =>
            router.navigate({ to: here().pathname, search: here().search, state: { sort } }),
        // A new filter is a new list: first page, default sort, and a shareable URL.
        filter: (q: string) =>
            router.navigate({
                to: here().pathname,
                search: q.trim() === "" ? {} : { q: q.trim() },
            }),
    };
}
