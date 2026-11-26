import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { openGeo, parseCountryDatabase } from "../src/base/adapters/geo/geo.ts";
import { countryDatabase } from "./geo-fixtures.ts";

const NETWORKS = [
    { cidr: "1.0.0.0/8", country: "AU" },
    { cidr: "2.0.0.0/8", country: "FR" },
    { cidr: "203.0.113.0/24", country: "JP" },
];

async function withDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "lucent-geo-"));
    const result = await work(dir);
    await rm(dir, { recursive: true, force: true });
    return result;
}

describe("the country file", () => {
    test("places an address in the country of the network holding it", () => {
        const lookup = parseCountryDatabase(countryDatabase(NETWORKS));
        invariant(lookup.ok, `the file parses: ${JSON.stringify(lookup)}`);
        expect(lookup.value("1.2.3.4")).toBe("AU");
        expect(lookup.value("2.255.0.1")).toBe("FR");
        expect(lookup.value("203.0.113.9")).toBe("JP");
    });

    test("places no address outside its networks, and no address that isn't one", () => {
        const lookup = parseCountryDatabase(countryDatabase(NETWORKS));
        invariant(lookup.ok, "the file parses");
        expect(lookup.value("10.0.0.1")).toBeNull();
        expect(lookup.value("203.0.114.1")).toBeNull();
        expect(lookup.value("not an address")).toBeNull();
    });

    test("bytes that aren't a country file are refused", () => {
        const parsed = parseCountryDatabase(new TextEncoder().encode("not a database"));
        expect(parsed.ok).toBe(false);
    });
});

describe("reloading", () => {
    test("a file loads, is left alone while unchanged, and a broken replacement keeps the last good one", async () => {
        await withDir(async (dir) => {
            const path = join(dir, "dbip-country-lite.mmdb");
            await writeFile(path, countryDatabase(NETWORKS));
            const geo = openGeo({ path });
            expect(geo.lookup()).toBeNull();
            expect(await geo.reload()).toEqual(ok("loaded"));
            expect(geo.lookup()?.("1.1.1.1")).toBe("AU");
            expect(await geo.reload()).toEqual(ok("unchanged"));

            await writeFile(path, "truncated in transit, and longer than before");
            const broken = await geo.reload();
            expect(!broken.ok && broken.error.code).toBe("GEO_UNREADABLE");
            expect(geo.lookup()?.("1.1.1.1")).toBe("AU");

            await writeFile(path, countryDatabase([{ cidr: "1.0.0.0/8", country: "NZ" }]));
            expect(await geo.reload()).toEqual(ok("loaded"));
            expect(geo.lookup()?.("1.1.1.1")).toBe("NZ");
        });
    });

    test("a missing file is unreadable and leaves nothing to look up", async () => {
        await withDir(async (dir) => {
            const geo = openGeo({ path: join(dir, "absent.mmdb") });
            const loaded = await geo.reload();
            expect(!loaded.ok && loaded.error.code).toBe("GEO_UNREADABLE");
            expect(geo.lookup()).toBeNull();
        });
    });
});
