import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import {
    entitlementState,
    type GrantForm,
    parseFeatures,
    parseGrant,
} from "../src/features/admin/accounts/grant.ts";

const CATALOG = [{ id: "cs2", channels: ["stable", "alpha", "debug"] }];
const NOW = EpochMs.parse(Date.UTC(2026, 10, 19, 12));
const FORM: GrantForm = { productId: "cs2", channels: ["alpha"], features: "", until: "" };

// Compared as plain data: the parsed values are branded, the expected ones are literals.
const plain = (value: unknown): unknown => value;

test("empty or a lone star is every feature; tags are split, lowercased and deduplicated", () => {
    expect(parseFeatures("")).toBe("*");
    expect(parseFeatures("  * ")).toBe("*");
    expect(plain(parseFeatures("aim, ESP  aim,esp.box"))).toEqual(["aim", "esp", "esp.box"]);
});

test("a tag the platform wouldn't take refuses the whole list", () => {
    expect(parseFeatures("aim, -esp")).toBeNull();
    expect(parseFeatures("aim, *")).toBeNull();
    expect(parseFeatures("x".repeat(65))).toBeNull();
});

test("a grant keeps only the ticked channels the product has, in the product's order", () => {
    const grant = plain(
        parseGrant({ ...FORM, channels: ["debug", "beta", "stable"] }, CATALOG, NOW),
    );
    expect(grant).toEqual({
        ok: true,
        value: { productId: "cs2", channels: ["stable", "debug"], features: "*", validUntil: null },
    });
});

test("a grant is refused without a known product, a channel, readable features or a future end", () => {
    expect(parseGrant({ ...FORM, productId: "osu" }, CATALOG, NOW)).toEqual({
        ok: false,
        error: "unknownProduct",
    });
    expect(parseGrant({ ...FORM, channels: ["beta"] }, CATALOG, NOW)).toEqual({
        ok: false,
        error: "noChannel",
    });
    expect(parseGrant({ ...FORM, features: "a b !" }, CATALOG, NOW)).toEqual({
        ok: false,
        error: "badFeature",
    });
    expect(parseGrant({ ...FORM, until: "2026-11-19" }, CATALOG, NOW)).toEqual({
        ok: false,
        error: "untilPast",
    });
    expect(plain(parseGrant({ ...FORM, until: "2026-11-20" }, CATALOG, NOW))).toEqual({
        ok: true,
        value: {
            productId: "cs2",
            channels: ["alpha"],
            features: "*",
            validUntil: Date.UTC(2026, 10, 20),
        },
    });
});

test("an entitlement reads as its status first, then as its window", () => {
    const window = { validFrom: EpochMs.parse(0), validUntil: null };
    expect(entitlementState({ ...window, status: "active" }, NOW)).toBe("active");
    expect(entitlementState({ ...window, status: "suspended" }, NOW)).toBe("suspended");
    expect(entitlementState({ ...window, status: "revoked" }, NOW)).toBe("revoked");
    expect(
        entitlementState({ status: "active", validFrom: EpochMs.parse(0), validUntil: NOW }, NOW),
    ).toBe("ended");
    expect(
        entitlementState(
            { status: "active", validFrom: EpochMs.parse(NOW + 1), validUntil: null },
            NOW,
        ),
    ).toBe("upcoming");
});
