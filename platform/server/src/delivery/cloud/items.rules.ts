import { err, ok, type Result } from "@lucent/core/result";

export type CloudLimits = {
    readonly maxItems: number;
    readonly maxVersionBytes: number;
    readonly maxStoredBytes: number;
    readonly maxVersionsPerItem: number;
};

export const CLOUD_LIMITS: CloudLimits = {
    maxItems: 100,
    maxVersionBytes: 48 * 1024,
    maxStoredBytes: 8 * 1024 * 1024,
    maxVersionsPerItem: 64,
};

export type CloudUsage = { readonly items: number; readonly storedBytes: number };

// What an append sees of its item under the scope lock: no item yet is head 0 with no versions.
export type AppendSnapshot = {
    readonly head: number;
    readonly versions: number;
    // The oldest retained version that is neither the head nor pinned by a share. Shares are
    // capped below the window, so a full window always has one; VERSION_LIMIT means limits
    // were configured without that room.
    readonly droppable: { readonly revision: number; readonly storedBytes: number } | null;
    readonly usage: CloudUsage;
};

export type AppendPlan = {
    readonly revision: number;
    readonly conflict: boolean;
    readonly drop: number | null;
};

type Refusal = {
    readonly code: "INVALID_BASE" | "ITEM_LIMIT" | "VERSION_LIMIT" | "SIZE_LIMIT" | "STORAGE_LIMIT";
};

// Server order, not the writer's clock or base, decides the head. A stale write still
// appends, leaving the displaced head readable at its original revision. History is a window:
// a full one drops its oldest droppable version to make room, and the bytes it frees count
// toward the new one.
export function decideAppend(
    params: AppendSnapshot & {
        readonly base: number;
        readonly versionBytes: number;
        readonly limits: CloudLimits;
    },
): Result<AppendPlan, Refusal> {
    const { head, base, versions, droppable, versionBytes, usage, limits } = params;
    if (!Number.isSafeInteger(base) || base > head || base < (head === 0 ? 0 : 1)) {
        return err({ code: "INVALID_BASE" });
    }
    if (head === 0 && usage.items >= limits.maxItems) return err({ code: "ITEM_LIMIT" });
    if (versionBytes > limits.maxVersionBytes) return err({ code: "SIZE_LIMIT" });
    const full = versions >= limits.maxVersionsPerItem;
    if (full && droppable === null) return err({ code: "VERSION_LIMIT" });
    const freed = full && droppable !== null ? droppable.storedBytes : 0;
    if (versionBytes > limits.maxStoredBytes - (usage.storedBytes - freed))
        return err({ code: "STORAGE_LIMIT" });
    return ok({
        revision: head + 1,
        conflict: head !== base,
        drop: full && droppable !== null ? droppable.revision : null,
    });
}
