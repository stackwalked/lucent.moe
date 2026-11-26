import { BLACK, fromHex, mix, type Rgba, TRANSPARENT, toCss, withAlpha } from "./color.ts";

// The design tokens as data. A Vite plugin (dev/tokens-plugin.ts) writes them out as the tokens
// layer, every color already resolved for both themes, and the contrast test reads the same
// values, so the CSS can't drift from what was measured. Old lucent's two themes, unchanged.

export const THEME_NAMES = ["graphite", "washi"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

// What a theme is made of. Pink means yours, current, needs you; shu means stopped, danger,
// refused. There are no other hues: success is ink with a check.
type ThemeInputs = {
    readonly ground: string;
    readonly side: string;
    readonly ink: string;
    readonly ink2: string;
    // Inert only (disabled controls): below text contrast on purpose.
    readonly ink3: string;
    readonly lineAlpha: number;
    readonly line2Alpha: number;
    readonly pink: string;
    readonly pinkInk: string;
    readonly shu: string;
    readonly shuInk: string;
    // Product and ticket states only: ok works, wait is changing.
    readonly okInk: string;
    readonly waitInk: string;
    // Role label colours: display only, set per role.
    readonly violetInk: string;
    readonly aquaInk: string;
    readonly shadow: Rgba;
};

const THEMES: Readonly<Record<ThemeName, ThemeInputs>> = {
    graphite: {
        ground: "#060506",
        side: "#0a090a",
        ink: "#efe9e6",
        ink2: "#aaa09c",
        ink3: "#7a706c",
        // Ink at these alphas over the ground lands on #18171a (hairlines) and #232225 (control
        // borders), the values the redesign mocks were drawn with.
        lineAlpha: 0.08,
        line2Alpha: 0.13,
        pink: "#e8a3b8",
        pinkInk: "#e8a3b8",
        shu: "#f25a2b",
        shuInk: "#f25a2b",
        okInk: "#8fd19e",
        waitInk: "#e8c07a",
        violetInk: "#c9a6f2",
        aquaInk: "#96d8e4",
        shadow: withAlpha(BLACK, 0.5),
    },
    washi: {
        ground: "#f6f2ef",
        side: "#efe9e5",
        ink: "#2a2226",
        ink2: "#6b6064",
        ink3: "#93898d",
        lineAlpha: 0.12,
        line2Alpha: 0.22,
        pink: "#da5a86",
        pinkInk: "#a6385f",
        shu: "#f25a2b",
        shuInk: "#bc3504",
        okInk: "#1d6f36",
        waitInk: "#7c5200",
        violetInk: "#7a3fc8",
        aquaInk: "#0d6e7e",
        shadow: withAlpha(fromHex("#2a2226"), 0.18),
    },
};

export const COLOR_TOKENS = [
    "ground",
    "side",
    "ink",
    "ink-2",
    "ink-3",
    "line",
    "line-2",
    "pink",
    "pink-ink",
    "shu",
    "shu-ink",
    "ok-ink",
    "wait-ink",
    "violet-ink",
    "aqua-ink",
    "shadow",
    "raised",
    "sunken",
    "floating",
    "floating-edge",
    "scrim",
    "hover",
    "chosen",
    "focus-ring",
    "pink-wash",
    "on-pink",
    "shu-wash",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export function resolveTheme(name: ThemeName): Readonly<Record<ColorToken, Rgba>> {
    const t = THEMES[name];
    const ground = fromHex(t.ground);
    const ink = fromHex(t.ink);
    const pink = fromHex(t.pink);
    const shu = fromHex(t.shu);
    const floating = mix(ink, 0.06, ground);
    return {
        ground,
        side: fromHex(t.side),
        ink,
        "ink-2": fromHex(t.ink2),
        "ink-3": fromHex(t.ink3),
        line: withAlpha(ink, t.lineAlpha),
        "line-2": withAlpha(ink, t.line2Alpha),
        pink,
        "pink-ink": fromHex(t.pinkInk),
        shu,
        "shu-ink": fromHex(t.shuInk),
        "ok-ink": fromHex(t.okInk),
        "wait-ink": fromHex(t.waitInk),
        "violet-ink": fromHex(t.violetInk),
        "aqua-ink": fromHex(t.aquaInk),
        shadow: t.shadow,
        // Surfaces and states, mixed from the inputs as old lucent's tokens.css did.
        raised: mix(ink, 0.03, ground),
        sunken: mix(BLACK, 0.08, ground),
        floating,
        "floating-edge": mix(ink, 0.2, floating),
        scrim: mix(ground, 0.72, TRANSPARENT),
        hover: mix(ink, 0.04, TRANSPARENT),
        chosen: mix(ink, 0.065, TRANSPARENT),
        "focus-ring": mix(pink, 0.85, ink),
        "pink-wash": mix(pink, 0.14, ground),
        "on-pink": mix(pink, 0.12, BLACK),
        "shu-wash": mix(shu, 0.1, ground),
    };
}

// The pairings components may use, and what the contrast test holds them to. Washi (old lucent's
// light theme, kept as it was) is what limits them:
// - pink and shu fills always carry their own text (on-pink, or ink on a wash), so a fill needs no
//   3:1 against its surface; a mark or icon on its own uses pink-ink or shu-ink;
// - sunken holds ink only (code, ids): Washi's ink-2, pink-ink and shu-ink drop under 4.5:1 there;
// - a chosen row on side holds ink only (Washi's ink-2 is 4.45:1 there).
// ink-3 is in none: it's for inert controls, which WCAG exempts (and the CSS lint keeps it there).
type Pair = { readonly fg: ColorToken; readonly bg: ColorToken };

const SURFACES = ["ground", "side", "raised", "floating"] as const;

export const TEXT_PAIRS: readonly Pair[] = [
    ...(
        [
            "ink",
            "ink-2",
            "pink-ink",
            "shu-ink",
            "ok-ink",
            "wait-ink",
            "violet-ink",
            "aqua-ink",
        ] as const
    ).flatMap((fg) => SURFACES.map((bg) => ({ fg, bg }))),
    { fg: "ink", bg: "sunken" },
    { fg: "ink", bg: "pink-wash" },
    { fg: "pink-ink", bg: "pink-wash" },
    { fg: "ink", bg: "shu-wash" },
    { fg: "shu-ink", bg: "shu-wash" },
    { fg: "on-pink", bg: "pink" },
];

export const UI_PAIRS: readonly Pair[] = (["focus-ring", "pink-ink", "shu-ink"] as const).flatMap(
    (fg) => [...SURFACES, "sunken" as const].map((bg) => ({ fg, bg })),
);

// Text over a translucent row state, measured on the composite with the surface beneath.
export const STATE_PAIRS: readonly {
    readonly fg: ColorToken;
    readonly layer: ColorToken;
    readonly surface: ColorToken;
}[] = [
    ...(["ground", "side"] as const).flatMap((surface) => [
        { fg: "ink" as const, layer: "hover" as const, surface },
        { fg: "ink-2" as const, layer: "hover" as const, surface },
        { fg: "ink" as const, layer: "chosen" as const, surface },
    ]),
    { fg: "ink-2", layer: "chosen", surface: "ground" },
];
const SPACE = {
    "s-1": 4,
    "s-2": 8,
    "s-3": 12,
    "s-4": 16,
    "s-5": 24,
    "s-6": 32,
    "s-7": 48,
    "s-8": 64,
};
const TYPE_SIZES = [12, 13, 14, 15, 17, 20, 24, 30] as const;

// Old lucent's motion values. Durations go to zero under prefers-reduced-motion.
const DURATIONS = {
    "t-hover": "120ms",
    "t-enter": "200ms",
    "t-exit": "140ms",
    "t-layout": "260ms",
    "t-spin": "1100ms",
    "t-page-out": "60ms",
    "t-page-in": "160ms",
};

const SCALES: Readonly<Record<string, string>> = {
    ...Object.fromEntries(Object.entries(SPACE).map(([name, px]) => [name, `${px}px`])),
    ...Object.fromEntries(TYPE_SIZES.map((px) => [`size-${px}`, `${px}px`])),
    "w-regular": "400",
    "w-medium": "500",
    "lh-tight": "1.2",
    "lh-snug": "1.35",
    "lh-body": "1.5",
    r: "6px",
    "r-inner": "4px",
    "r-round": "9999px",
    "z-nav": "10",
    "z-pop": "20",
    "z-dialog": "30",
    "z-toast": "40",
    ...DURATIONS,
    ease: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    "ease-in": "cubic-bezier(0.4, 0, 1, 1)",
    "page-slide": "8px",
    // The page is a centred column up to --page, gutters included, bar and content alike; a
    // one-thing page stops at --page-narrow; a form stays --form wide. --page-gap and
    // --caption-h put the first hairline of every page 80px under the bar. --aside is the narrow
    // column of a two-column page.
    page: "1376px",
    "page-narrow": "1040px",
    form: "480px",
    gutter: "24px",
    "page-gap": "40px",
    "caption-h": "40px",
    aside: "444px",
    // The measure of an entry row's version-and-date gutter, from the product mock; only the
    // changelog rows use it.
    "entry-gutter": "180px",
    "control-h": "32px",
    "control-sm": "24px",
    "nav-h": "44px",
    "row2-h": "36px",
    "side-w": "220px",
    "font-sans": '"IBM Plex Sans", "IBM Plex Sans Fallback", system-ui, sans-serif',
    "font-mono": '"Geist Mono", "Geist Mono Fallback", ui-monospace, monospace',
};

// Every custom property the tokens layer defines: module CSS may use these, and its own
// `--_name` locals, and nothing else (dev/css-lint.ts).
export const TOKEN_NAMES: ReadonlySet<string> = new Set([...COLOR_TOKENS, ...Object.keys(SCALES)]);

export const LAYER_ORDER = "@layer reset, tokens, base, layout, components, features, overrides;";

export function tokenStylesheet(): string {
    const graphite = resolveTheme("graphite");
    const washi = resolveTheme("washi");
    const colors = COLOR_TOKENS.map(
        (name) => `    --${name}: light-dark(${toCss(washi[name])}, ${toCss(graphite[name])});`,
    );
    const scales = Object.entries(SCALES).map(([name, value]) => `    --${name}: ${value};`);
    const stilled = Object.keys(DURATIONS).map((name) => `        --${name}: 0ms;`);
    return [
        "/* Generated from web/src/ui/tokens.ts by dev/tokens-plugin.ts: edit that, not this. */",
        LAYER_ORDER,
        "@layer tokens {",
        "  :root {",
        "    color-scheme: light dark;",
        ...colors,
        ...scales,
        "  }",
        // On any element, not just the root: light-dark() resolves where a token is used, so a
        // subtree can show the other theme (as /dev/kit does).
        '  [data-theme="graphite"] { color-scheme: dark; }',
        '  [data-theme="washi"] { color-scheme: light; }',
        "  @media (max-width: 640px) { :root { --gutter: 16px; } }",
        "  @media (prefers-reduced-motion: reduce) {",
        "    :root {",
        ...stilled,
        "        --page-slide: 0px;",
        "    }",
        "  }",
        "}",
        "",
    ].join("\n");
}
