import { expect, test } from "bun:test";
import { contrast, over } from "../src/ui/color.ts";
import {
    type ColorToken,
    resolveTheme,
    STATE_PAIRS,
    TEXT_PAIRS,
    THEME_NAMES,
    UI_PAIRS,
} from "../src/ui/tokens.ts";

// WCAG 2.2 AA: 4.5:1 for text, 3:1 for what tells a control apart. Each failure is listed as
// "theme fg on bg: ratio", so a palette change shows exactly what it broke.
function failures(min: number, pairs: readonly { fg: ColorToken; bg: ColorToken }[]): string[] {
    const out: string[] = [];
    for (const theme of THEME_NAMES) {
        const colors = resolveTheme(theme);
        for (const { fg, bg } of pairs) {
            const ratio = contrast(colors[fg], colors[bg]);
            if (ratio < min) out.push(`${theme} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
    }
    return out;
}

test("every text and surface pair reads at 4.5:1 or better, in both themes", () => {
    expect(failures(4.5, TEXT_PAIRS)).toEqual([]);
});

test("focus rings and pink and shu marks stand out at 3:1 or better, in both themes", () => {
    expect(failures(3, UI_PAIRS)).toEqual([]);
});

test("text stays readable on a hovered or chosen row", () => {
    const out: string[] = [];
    for (const theme of THEME_NAMES) {
        const colors = resolveTheme(theme);
        for (const { fg, layer, surface } of STATE_PAIRS) {
            const ratio = contrast(colors[fg], over(colors[layer], colors[surface]));
            if (ratio < 4.5) out.push(`${theme} ${fg} on ${layer}/${surface}: ${ratio.toFixed(2)}`);
        }
    }
    expect(out).toEqual([]);
});
