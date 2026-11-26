import type { Clock } from "@lucent/core/clock";
import { tryAsync } from "@lucent/core/contain";
import type { EpochMs } from "@lucent/core/scalars";

// The public record as web last had it from platform, held in this process's memory only. A read
// younger than `freshMs` is served as it is, and concurrent requests share one read in flight, so
// anyone hitting the pages costs platform at most one read per window. While platform can't be
// reached the pages show the last read with the time platform gave it; before web has had one (a
// restart while platform is down) they say status is unavailable. No disk, no second store.

export type Snapshot<T> =
    | { readonly state: "current"; readonly value: T; readonly at: EpochMs }
    | { readonly state: "stale"; readonly value: T; readonly at: EpochMs }
    | { readonly state: "unavailable" };

export type SnapshotRead<T> =
    | { readonly ok: true; readonly value: T; readonly at: EpochMs }
    | { readonly ok: false };

export const SNAPSHOT_FRESH_MS = 15_000;

export function createSnapshot<T>(params: {
    readonly clock: Clock;
    readonly read: () => Promise<SnapshotRead<T>>;
    readonly freshMs?: number;
}): () => Promise<Snapshot<T>> {
    const freshMs = params.freshMs ?? SNAPSHOT_FRESH_MS;
    let last: { readonly value: T; readonly at: EpochMs; readonly readAt: number } | null = null;
    let inFlight: Promise<Snapshot<T>> | null = null;

    // A read that throws counts as platform unreachable; either way the next request reads again.
    const refresh = async (): Promise<Snapshot<T>> => {
        const tried = await tryAsync(params.read, () => null);
        inFlight = null;
        const fresh: SnapshotRead<T> = tried.ok ? tried.value : { ok: false };
        if (fresh.ok) {
            last = { value: fresh.value, at: fresh.at, readAt: params.clock.now() };
            return { state: "current", value: fresh.value, at: fresh.at };
        }
        if (last === null) return { state: "unavailable" };
        return { state: "stale", value: last.value, at: last.at };
    };

    return async () => {
        if (last !== null && params.clock.now() - last.readAt < freshMs) {
            return { state: "current", value: last.value, at: last.at };
        }
        inFlight ??= refresh();
        return await inFlight;
    };
}
