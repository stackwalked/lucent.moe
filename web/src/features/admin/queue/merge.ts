import type { EpochMs } from "@lucent/core/scalars";
import type { Action } from "@lucent/policy/action-list";

// Everything that waits for staff, from the five reads that hold it.
export const QUEUE_KINDS = ["tickets", "applications", "reports", "flags", "listings"] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

// The permission that lets staff see a kind: a kind the viewer lacks it for is not read at all.
export const QUEUE_ACTIONS: Readonly<Record<QueueKind, Action>> = {
    tickets: "tickets:reply",
    applications: "applications:review",
    reports: "moderation:remove",
    flags: "risk:review",
    listings: "moderation:remove",
};

export type QueueRow = {
    readonly kind: QueueKind;
    readonly id: string;
    readonly title: string;
    readonly context: string;
    readonly who: { readonly accountId: string; readonly username: string | null } | null;
    // When it started waiting.
    readonly at: EpochMs;
};

export function queueKinds(allowed: (action: Action) => boolean): readonly QueueKind[] {
    return QUEUE_KINDS.filter((kind) => allowed(QUEUE_ACTIONS[kind]));
}

const KIND_ORDER = new Map(QUEUE_KINDS.map((kind, index) => [kind, index]));

// Oldest first across kinds; the same moment keeps a fixed order (kind, then id) so the list does
// not shuffle between loads. Only the pages loaded so far are in it: a kind with more behind its
// last page can still hold something older than rows already shown.
export function mergeQueue(parts: Partial<Record<QueueKind, readonly QueueRow[]>>): QueueRow[] {
    return QUEUE_KINDS.flatMap((kind) => parts[kind] ?? []).sort(
        (a, b) =>
            a.at - b.at ||
            (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
            a.id.localeCompare(b.id),
    );
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export function waitedLong(at: EpochMs, now: EpochMs): boolean {
    return now - at > DAY_MS;
}

// "3", or "3+" when the read has more than it gave.
export function countWord(loaded: number, extent: "all" | "partial"): string {
    return `${loaded}${extent === "partial" ? "+" : ""}`;
}
