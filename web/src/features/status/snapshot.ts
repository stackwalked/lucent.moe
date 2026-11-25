import type { EpochMs } from "@lucent/core/scalars";

// The public record as web last had it from platform, held in this process's memory only: while
// platform can't be reached the pages show it with the time platform gave it, and before web has
// had one (a restart while platform is down) they say status is unavailable. No disk, no second
// store.

export type Snapshot<T> =
    | { readonly state: "current"; readonly value: T; readonly at: EpochMs }
    | { readonly state: "stale"; readonly value: T; readonly at: EpochMs }
    | { readonly state: "unavailable" };

export type SnapshotRead<T> =
    | { readonly ok: true; readonly value: T; readonly at: EpochMs }
    | { readonly ok: false };

export function createSnapshot<T>(): (
    read: () => Promise<SnapshotRead<T>>,
) => Promise<Snapshot<T>> {
    let last: { readonly value: T; readonly at: EpochMs } | null = null;
    return async (read) => {
        const fresh = await read();
        if (fresh.ok) {
            last = { value: fresh.value, at: fresh.at };
            return { state: "current", value: fresh.value, at: fresh.at };
        }
        if (last === null) return { state: "unavailable" };
        return { state: "stale", value: last.value, at: last.at };
    };
}
