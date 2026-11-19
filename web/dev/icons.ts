import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "@lucent/core/contain";

// Builds src/ui/icons/sprite.gen.svg from the vendored Lucide SVGs: one <symbol> each, its id the
// file's name. The stroke settings live on Icon's own <svg>, which the symbols inherit through
// <use>, so the sprite carries shapes only.
export function writeSprite(dir: string): void {
    const symbols = readdirSync(join(dir, "lucide"))
        .filter((file) => file.endsWith(".svg"))
        .sort()
        .map((file) => {
            const svg = readFileSync(join(dir, "lucide", file), "utf8");
            const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1];
            invariant(inner !== undefined, `${file} is not an SVG`);
            const shapes = inner.replace(/\s+/g, " ").trim();
            return `<symbol id="${file.slice(0, -".svg".length)}" viewBox="0 0 24 24">${shapes}</symbol>`;
        });
    writeFileSync(
        join(dir, "sprite.gen.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide, ISC: see lucide/LICENSE -->${symbols.join("")}</svg>\n`,
    );
}
