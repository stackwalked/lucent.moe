import { err, ok, type Result } from "@lucent/core/result";

export const LISTING_PAGE_SIZE = 25;
export const LISTING_NAME_MAX = 60;

export type ListingKind = "config" | "inventory" | "script";
export type ListingState = "pending" | "listed";

// What a listing pins: the snapshot others see (`revision`), a script's newer one waiting for
// staff (`pending`), and the state those two make. A script runs code, so a new or changed one
// is held for staff while the last approved snapshot, if there is one, stays visible.
export type Pins = {
    readonly state: ListingState;
    readonly revision: number | null;
    readonly pending: number | null;
};

// A first listing of the item's head.
export function decideFirstPin(params: {
    readonly kind: ListingKind;
    readonly head: number;
}): Pins {
    return params.kind === "script"
        ? { state: "pending", revision: null, pending: params.head }
        : { state: "listed", revision: params.head, pending: null };
}

// Re-pinning from the item's current head. A script that was already visible stays at its
// approved snapshot until staff approve the new one; anything else goes straight to the head.
export function decideRepin(params: {
    readonly kind: ListingKind;
    readonly current: Pins;
    readonly head: number;
}): Pins {
    if (params.kind !== "script") {
        return { state: "listed", revision: params.head, pending: null };
    }
    return params.current.revision === null
        ? { state: "pending", revision: null, pending: params.head }
        : { state: "listed", revision: params.current.revision, pending: params.head };
}

// Approval makes the waiting snapshot the visible one; with nothing waiting there is nothing to
// approve. Staff approve the revision they read: the owner can re-pin after staff looked, and a
// different snapshot must not go live on the strength of a review of another.
export function decideApproval(
    current: Pins,
    seen: number,
): Result<Pins, { readonly code: "NOT_FOUND" } | { readonly code: "STALE_REVISION" }> {
    if (current.pending === null) return err({ code: "NOT_FOUND" });
    if (current.pending !== seen) return err({ code: "STALE_REVISION" });
    return ok({ state: "listed", revision: current.pending, pending: null });
}

// Item names run to 64 code points; a listing's to 60, cut at a code point.
export function listingName(name: string): string {
    return [...name].slice(0, LISTING_NAME_MAX).join("");
}
