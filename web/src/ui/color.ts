// sRGB and OKLab, enough to resolve the tokens' color-mix() rules here instead of in the browser
// (so the CSS is exactly what the contrast test measured) and to compute WCAG contrast.
// Conversions: Björn Ottosson's OKLab (https://bottosson.github.io/posts/oklab/), sRGB transfer
// per IEC 61966-2-1, relative luminance and contrast per WCAG 2.2.

export type Rgba = {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
};

type Lab = { readonly l: number; readonly a: number; readonly b: number; readonly alpha: number };

export function fromHex(hex: string): Rgba {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (match === null) return { r: 0, g: 0, b: 0, a: 0 };
    const [, r = "0", g = "0", b = "0"] = match;
    return {
        r: Number.parseInt(r, 16) / 255,
        g: Number.parseInt(g, 16) / 255,
        b: Number.parseInt(b, 16) / 255,
        a: 1,
    };
}

export function withAlpha(color: Rgba, a: number): Rgba {
    return { ...color, a };
}

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

function toLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(c: number): number {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function toLab(color: Rgba): Lab {
    const r = toLinear(color.r);
    const g = toLinear(color.g);
    const b = toLinear(color.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
        l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
        alpha: color.a,
    };
}

function clamp(c: number): number {
    return Math.min(1, Math.max(0, c));
}

function fromLab(lab: Lab): Rgba {
    const l = (lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
    const m = (lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
    const s = (lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;
    return {
        r: clamp(fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
        g: clamp(fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
        b: clamp(fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
        a: lab.alpha,
    };
}

// CSS color-mix(in oklab, first p, second): premultiplied by alpha, as CSS Color 5 specifies,
// so mixing with transparent keeps the color and scales its alpha.
export function mix(first: Rgba, p: number, second: Rgba): Rgba {
    const x = toLab(first);
    const y = toLab(second);
    const alpha = x.alpha * p + y.alpha * (1 - p);
    if (alpha === 0) return TRANSPARENT;
    const channel = (u: number, v: number) => (u * x.alpha * p + v * y.alpha * (1 - p)) / alpha;
    return fromLab({ l: channel(x.l, y.l), a: channel(x.a, y.a), b: channel(x.b, y.b), alpha });
}

// What a translucent color looks like on an opaque one: browsers composite in sRGB.
export function over(top: Rgba, bottom: Rgba): Rgba {
    const blend = (t: number, b: number) => t * top.a + b * (1 - top.a);
    return {
        r: blend(top.r, bottom.r),
        g: blend(top.g, bottom.g),
        b: blend(top.b, bottom.b),
        a: 1,
    };
}

function luminance(color: Rgba): number {
    return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

export function contrast(fg: Rgba, bg: Rgba): number {
    const shown = over(fg, bg);
    const a = luminance(shown);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hexByte(c: number): string {
    return Math.round(c * 255)
        .toString(16)
        .padStart(2, "0");
}

export function toCss(color: Rgba): string {
    const rgb = `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
    if (color.a >= 1) return rgb;
    const channels = [color.r, color.g, color.b].map((c) => Math.round(c * 255)).join(" ");
    return `rgb(${channels} / ${Number(color.a.toFixed(4))})`;
}
