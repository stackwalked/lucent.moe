import type { EpochMs } from "@lucent/core/scalars";

// What approving a waiting PC would do to the member's PCs, so the page says so before they
// approve, and hides what platform would refuse. Platform decides again when it's sent.
export type ApprovalChange =
    | { readonly kind: "adds" }
    | { readonly kind: "replaces" }
    | { readonly kind: "waits"; readonly until: EpochMs };

type DeviceList = {
    readonly devices: readonly unknown[];
    readonly limit: number;
    // When the member may next change a PC themselves; null when they may now.
    readonly replaceableFrom: EpochMs | null;
};

export function approvalChange(list: DeviceList): ApprovalChange {
    if (list.devices.length < list.limit) return { kind: "adds" };
    if (list.replaceableFrom !== null) return { kind: "waits", until: list.replaceableFrom };
    return { kind: "replaces" };
}

// Removing is the same self-service change as replacing: one a week.
export function mayRemove(list: DeviceList): boolean {
    return list.replaceableFrom === null;
}
