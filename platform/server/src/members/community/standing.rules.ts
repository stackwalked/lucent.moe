import { err, ok, type Result } from "@lucent/core/result";
import type { EpochMs, ProductId } from "@lucent/core/scalars";

export const RESTRICTION_KINDS = ["muted", "barred"] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export const POSTING_SURFACES = ["profile", "comment", "shout", "listing"] as const;
export type PostingSurface = (typeof POSTING_SURFACES)[number];

export type Restriction = {
    readonly kind: RestrictionKind;
    readonly productId: ProductId | null;
    readonly endsAt: EpochMs | null;
};

export type PostingRefusal = {
    readonly code: "POSTING_RESTRICTED";
    readonly kind: RestrictionKind;
    readonly productId: ProductId | null;
    readonly endsAt: EpochMs | null;
};

// Muted keeps the voice in conversation off (comments, shouts) and offers to others (cloud
// listings); barred closes every surface a
// member writes on. Neither says anything about licences, which this file never sees.
const CLOSED_BY: Readonly<Record<RestrictionKind, ReadonlySet<PostingSurface>>> = {
    muted: new Set<PostingSurface>(["comment", "shout", "listing"]),
    barred: new Set<PostingSurface>(POSTING_SURFACES),
};

function outlasts(a: Restriction, b: Restriction): boolean {
    if (a.endsAt === null) return b.endsAt !== null;
    return b.endsAt !== null && a.endsAt > b.endsAt;
}

// A restriction naming a product closes that product's surfaces only; one naming none closes
// everything, including surfaces with no product (profile, a shout with no product). When several
// apply the refusal names the one that lasts longest, so the member learns when they are free.
export function decidePosting(params: {
    readonly restrictions: readonly Restriction[];
    readonly surface: PostingSurface;
    readonly productId: ProductId | null;
    readonly now: EpochMs;
}): Result<null, PostingRefusal> {
    let binding: Restriction | null = null;
    for (const restriction of params.restrictions) {
        if (restriction.endsAt !== null && restriction.endsAt <= params.now) continue;
        if (restriction.productId !== null && restriction.productId !== params.productId) continue;
        if (!CLOSED_BY[restriction.kind].has(params.surface)) continue;
        if (binding === null || outlasts(restriction, binding)) binding = restriction;
    }
    if (binding === null) return ok(null);
    return err({
        code: "POSTING_RESTRICTED",
        kind: binding.kind,
        productId: binding.productId,
        endsAt: binding.endsAt,
    });
}

export type RestrictionRefusal =
    | { readonly code: "UNKNOWN_PRODUCT" }
    | { readonly code: "INVALID_WINDOW" };

export function decideRestriction(params: {
    readonly now: EpochMs;
    readonly endsAt: EpochMs | null;
    readonly productId: ProductId | null;
    readonly productKnown: boolean;
}): Result<null, RestrictionRefusal> {
    if (params.productId !== null && !params.productKnown) return err({ code: "UNKNOWN_PRODUCT" });
    if (params.endsAt !== null && params.endsAt <= params.now) {
        return err({ code: "INVALID_WINDOW" });
    }
    return ok(null);
}
