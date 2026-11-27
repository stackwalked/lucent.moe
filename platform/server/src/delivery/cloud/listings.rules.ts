import { trySync } from "@lucent/core/contain";
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
    // The head is what is already pinned, or already waiting: nothing moved, so nothing to
    // re-pin, and a script is not sent to staff again for a change of words alone.
    if (params.head === (params.current.pending ?? params.current.revision)) return params.current;
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

// What a listing page shows of the listed snapshot. The server does not know the formats a game's
// configs and inventories are written in: their bytes are the client's own. So the rule is by
// what the bytes are, not by what they claim to be: well-formed UTF-8 with no control characters
// beyond tab and line breaks is text and shown as it is (a script is source text, so always
// this), and anything else is opaque and not shown. A config or inventory that is compact JSON is
// laid out, since that is how a machine writes it; text already laid out is left alone, so what
// is shown is never a different document from what is installed.
export const CONTENT_SHOWN_MAX_BYTES = 256 * 1024;

function hasControl(text: string): boolean {
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
            return true;
    }
    return false;
}

export type ListingContent = { readonly text: string | null; readonly size: number };

export function decideListingContent(params: {
    readonly kind: ListingKind;
    readonly bytes: Uint8Array;
}): ListingContent {
    const size = params.bytes.byteLength;
    if (size > CONTENT_SHOWN_MAX_BYTES) return { text: null, size };
    const decoded = trySync(
        () => new TextDecoder("utf-8", { fatal: true }).decode(params.bytes),
        () => null,
    );
    if (!decoded.ok || hasControl(decoded.value)) return { text: null, size };
    if (params.kind === "script") return { text: decoded.value, size };
    // Indentation grows with depth squared: 48 KB of brackets would lay out to over a gigabyte.
    // So deep input is not laid out, and neither is a result past what a page should carry.
    if (jsonDepthExceeds(decoded.value, LAID_OUT_DEPTH_MAX)) return { text: decoded.value, size };
    const laidOut = trySync(
        (): string | null => {
            const parsed: unknown = JSON.parse(decoded.value);
            return JSON.stringify(parsed) === decoded.value
                ? JSON.stringify(parsed, null, 2)
                : null;
        },
        () => null,
    );
    if (!laidOut.ok || laidOut.value === null || laidOut.value.length > LAID_OUT_MAX_CHARS) {
        return { text: decoded.value, size };
    }
    return { text: laidOut.value, size };
}

export const LAID_OUT_DEPTH_MAX = 32;
export const LAID_OUT_MAX_CHARS = 1024 * 1024;

// Nesting of brackets and braces outside strings, one pass, stopping as soon as `limit` is passed.
function jsonDepthExceeds(text: string, limit: number): boolean {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let at = 0; at < text.length; at++) {
        const char = text.charCodeAt(at);
        if (inString) {
            if (escaped) escaped = false;
            else if (char === 0x5c) escaped = true;
            else if (char === 0x22) inString = false;
            continue;
        }
        if (char === 0x22) inString = true;
        else if (char === 0x5b || char === 0x7b) {
            depth++;
            if (depth > limit) return true;
        } else if (char === 0x5d || char === 0x7d) depth--;
    }
    return false;
}
