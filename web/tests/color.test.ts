import { expect, test } from "bun:test";
import { BLACK, contrast, fromHex, mix, TRANSPARENT, toCss } from "../src/ui/color.ts";

// Reference values: WCAG's extremes, and OKLab's mid-gray (L = 0.5 is linear 0.125, sRGB 99).
const WHITE = fromHex("#ffffff");

test("black on white is 21:1 and a color on itself 1:1", () => {
    expect(contrast(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrast(WHITE, WHITE)).toBeCloseTo(1, 5);
});

test("mixing in OKLab lands where CSS color-mix() does", () => {
    expect(toCss(mix(WHITE, 0.5, BLACK))).toBe("#636363");
    expect(toCss(mix(fromHex("#f25a2b"), 1, BLACK))).toBe("#f25a2b");
});

test("mixing with transparent keeps the color and scales its alpha", () => {
    expect(toCss(mix(fromHex("#2a2226"), 0.04, TRANSPARENT))).toBe("rgb(42 34 38 / 0.04)");
});
