import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProductCatalog } from "../src/catalog.ts";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function catalogDirWith(file: string, toml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "lucent-products-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, file), toml);
    return dir;
}

test("a product file named differently from its id is refused", () => {
    const dir = catalogDirWith(
        "wrong.toml",
        'id = "cs2"\nname = "CS2"\nkind = "module"\nstate = "live"\nchannels = ["stable"]\n[defaults]\nconcurrent_slots = 1\n',
    );
    expect(loadProductCatalog(dir)).toMatchObject({
        ok: false,
        error: { code: "CATALOG_INVALID", file: "wrong.toml" },
    });
});

test("a product listing a channel twice is refused", () => {
    const dir = catalogDirWith(
        "cs2.toml",
        'id = "cs2"\nname = "CS2"\nkind = "module"\nstate = "seed"\nchannels = ["stable", "stable"]\n[defaults]\nconcurrent_slots = 1\n',
    );
    expect(loadProductCatalog(dir)).toMatchObject({
        ok: false,
        error: { code: "CATALOG_INVALID", file: "cs2.toml" },
    });
});

test("a product without a lifecycle state is refused by filename", () => {
    const dir = catalogDirWith(
        "cs2.toml",
        'id = "cs2"\nname = "CS2"\nkind = "module"\nchannels = ["stable"]\n[defaults]\nconcurrent_slots = 1\n',
    );
    expect(loadProductCatalog(dir)).toMatchObject({
        ok: false,
        error: { code: "CATALOG_INVALID", file: "cs2.toml" },
    });
});
