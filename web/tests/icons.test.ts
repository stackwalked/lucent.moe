import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ICON_NAMES } from "../src/ui/Icon/names.ts";

test("the icon names are exactly the vendored Lucide files", () => {
    const files = readdirSync(join(import.meta.dir, "../src/ui/icons/lucide"))
        .filter((file) => file.endsWith(".svg"))
        .map((file) => file.slice(0, -".svg".length))
        .sort();
    const names: string[] = [...ICON_NAMES].sort();
    expect(names).toEqual(files);
});
