import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { TOKEN_NAMES } from "../src/ui/tokens.ts";

// What module CSS may say, beyond what Biome checks:
// - everything inside one layer: components, features, or layout (the page frames);
// - colors and sizes from tokens only: no color literals, no px beyond hairlines (1px, 2px),
//   except in @media and @container conditions;
// - var() names a token, or a module-local `--_name`;
// - ink-3 only where a control is inert (:disabled, aria-disabled, data-inert);
// - no !important: the layer order is what wins.

const LAYERS = new Set(["components", "features", "layout"]);
const COLOR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const NAMED_COLOR =
    /(?<![-\w])(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)(?![-\w])/;
const INERT = /:disabled|aria-disabled|data-inert/;

function withoutComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function lineOf(css: string, index: number): number {
    return css.slice(0, index).split("\n").length;
}

// The innermost selector (or at-rule prelude) whose block contains `index`.
function blockHeadAt(css: string, index: number): string {
    let depth = 0;
    for (let i = index; i >= 0; i--) {
        if (css[i] === "}") depth++;
        if (css[i] === "{") {
            if (depth === 0) {
                const start =
                    Math.max(
                        css.lastIndexOf("}", i),
                        css.lastIndexOf(";", i),
                        css.lastIndexOf("{", i - 1),
                    ) + 1;
                return css.slice(start, i).trim();
            }
            depth--;
        }
    }
    return "";
}

export function lintModuleCss(file: string, source: string): readonly string[] {
    const css = withoutComments(source);
    const problems: string[] = [];
    const at = (index: number, message: string) =>
        problems.push(`${file}:${lineOf(css, index)}: ${message}`);

    const layer = /^\s*@layer\s+([a-z-]+)\s*\{/.exec(css);
    if (layer === null || layer[1] === undefined || !LAYERS.has(layer[1])) {
        at(0, "a module's rules go inside @layer components, features or layout");
    }
    if (layer !== null) {
        let depth = 0;
        let end = -1;
        for (let i = layer.index + layer[0].length - 1; i < css.length && end < 0; i++) {
            if (css[i] === "{") depth++;
            if (css[i] === "}" && --depth === 0) end = i;
        }
        if (end < 0 || css.slice(end + 1).trim() !== "") {
            at(Math.max(end, 0), "everything stays inside the one layer block");
        }
    }
    for (const match of css.matchAll(/!important/g))
        at(match.index, "no !important: layers decide");

    for (const match of css.matchAll(/[^{};]+:[^{};]+;/g)) {
        const declaration = match[0];
        const index = match.index;
        const head = blockHeadAt(css, index);
        if (head.startsWith("@media") || head.startsWith("@container")) continue;
        const value = declaration.slice(declaration.indexOf(":") + 1);
        const unwrapped = value.replace(/var\([^)]*\)/g, "");
        if (HEX.test(unwrapped) || COLOR_FUNCTION.test(unwrapped) || NAMED_COLOR.test(unwrapped)) {
            at(index, `colors come from tokens: ${declaration.trim()}`);
        }
        for (const px of value.matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g)) {
            if (!["0", "1", "2"].includes(px[1] ?? ""))
                at(index, `sizes come from tokens: ${declaration.trim()}`);
        }
        for (const use of value.matchAll(/var\(--([a-zA-Z0-9_-]+)/g)) {
            const name = use[1] ?? "";
            if (!name.startsWith("_") && !TOKEN_NAMES.has(name)) at(index, `no token --${name}`);
            if (name === "ink-3" && !INERT.test(head))
                at(index, "ink-3 is for inert controls only");
        }
    }
    return problems;
}

function moduleFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return moduleFiles(path);
        return entry.endsWith(".module.css") ? [path] : [];
    });
}

if (import.meta.main) {
    const root = join(import.meta.dir, "..");
    const problems = moduleFiles(join(root, "src")).flatMap((file) =>
        lintModuleCss(relative(root, file).replaceAll("\\", "/"), readFileSync(file, "utf8")),
    );
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exit(problems.length === 0 ? 0 : 1);
}
