import { expect, test } from "bun:test";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import {
    decidePosting,
    decideRestriction,
    type PostingRefusal,
    type PostingSurface,
    type Restriction,
} from "../src/members/community/standing.rules.ts";

const now = EpochMs.parse(1_000_000);
const later = EpochMs.parse(2_000_000);
const latest = EpochMs.parse(3_000_000);
const cs2 = ProductId.parse("cs2");
const loader = ProductId.parse("lucent-loader");

const muted = (productId: ProductId | null, endsAt: EpochMs | null): Restriction => ({
    kind: "muted",
    productId,
    endsAt,
});
const barred = (productId: ProductId | null, endsAt: EpochMs | null): Restriction => ({
    kind: "barred",
    productId,
    endsAt,
});
const refused = (r: Restriction): Result<null, PostingRefusal> =>
    err({ code: "POSTING_RESTRICTED", ...r });

test.each<
    readonly [
        string,
        readonly Restriction[],
        PostingSurface,
        ProductId | null,
        Result<null, PostingRefusal>,
    ]
>([
    ["no restriction posts anywhere", [], "comment", cs2, ok(null)],
    [
        "a bar on one product closes that product",
        [barred(cs2, null)],
        "guide",
        cs2,
        refused(barred(cs2, null)),
    ],
    ["a bar on one product leaves another open", [barred(cs2, null)], "guide", loader, ok(null)],
    [
        "a bar on one product leaves product-less surfaces open",
        [barred(cs2, null)],
        "shout",
        null,
        ok(null),
    ],
    [
        "a bar everywhere closes a product-less surface",
        [barred(null, later)],
        "profile",
        null,
        refused(barred(null, later)),
    ],
    ["a mute closes comments", [muted(null, null)], "comment", cs2, refused(muted(null, null))],
    ["a mute closes shouts", [muted(cs2, null)], "shout", cs2, refused(muted(cs2, null))],
    ["a mute leaves guides open", [muted(null, null)], "guide", cs2, ok(null)],
    ["a mute leaves the profile open", [muted(null, null)], "profile", null, ok(null)],
    ["a restriction past its end is no restriction", [barred(null, now)], "comment", cs2, ok(null)],
    [
        "the longest applicable restriction is the one named",
        [barred(cs2, later), muted(null, latest)],
        "comment",
        cs2,
        refused(muted(null, latest)),
    ],
    [
        "no end outlasts any end",
        [muted(null, latest), barred(null, null)],
        "comment",
        null,
        refused(barred(null, null)),
    ],
])("%s", (_name, restrictions, surface, productId, expected) => {
    expect(decidePosting({ restrictions, surface, productId, now })).toEqual(expected);
});

test.each([
    ["a window ending in the future with a known product", later, cs2, true, ok(null)],
    ["no end and no product", null, null, false, ok(null)],
    ["an end that has passed", now, null, false, err({ code: "INVALID_WINDOW" })],
    ["a product the catalog lacks", null, loader, false, err({ code: "UNKNOWN_PRODUCT" })],
    [
        "both refusals at once name the product first",
        now,
        loader,
        false,
        err({ code: "UNKNOWN_PRODUCT" }),
    ],
] as const)("a restriction with %s", (_name, endsAt, productId, productKnown, expected) => {
    expect(decideRestriction({ now, endsAt, productId, productKnown })).toEqual(expected);
});
