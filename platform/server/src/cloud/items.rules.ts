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
type Refusal = {
    readonly code: "INVALID_BASE" | "ITEM_LIMIT" | "VERSION_LIMIT" | "SIZE_LIMIT" | "STORAGE_LIMIT";
};

// Server order, not the writer's clock or base, decides the head. A stale write still
// appends, leaving the displaced head readable at its original revision.
export function decideAppend(params: {
    readonly head: number;
    readonly base: number;
    readonly versionBytes: number;
    readonly usage: CloudUsage;
    readonly limits: CloudLimits;
}): Result<{ readonly revision: number; readonly conflict: boolean }, Refusal> {
    const { head, base, versionBytes, usage, limits } = params;
    if (!Number.isSafeInteger(base) || base > head || base < (head === 0 ? 0 : 1)) {
        return err({ code: "INVALID_BASE" });
    }
    if (head === 0 && usage.items >= limits.maxItems) return err({ code: "ITEM_LIMIT" });
    if (versionBytes > limits.maxVersionBytes) return err({ code: "SIZE_LIMIT" });
    if (versionBytes > limits.maxStoredBytes - usage.storedBytes)
        return err({ code: "STORAGE_LIMIT" });
    if (head >= limits.maxVersionsPerItem) return err({ code: "VERSION_LIMIT" });
    return ok({ revision: head + 1, conflict: head !== base });
}
