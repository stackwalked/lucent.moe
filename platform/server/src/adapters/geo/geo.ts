import * as nodeBuffer from "node:buffer";
import { describeUnknownError, tryAsync, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { type CountryResponse, Reader } from "mmdb-lib";
import { z } from "zod";

// Where a sign-in came from, by country, from the DB-IP Lite country file (mmdb-lib 3.0.5 reads
// it). Offline only: the file is read from disk and read again when it changes, never fetched;
// an address is never sent anywhere. DB-IP's country file uses the GeoIP2 Country layout, so the
// country is `country.iso_code`.

// ISO 3166-1 alpha-2, as the file spells it.
export type Country = string;

// The country an address is in, or null when the file doesn't place it (private ranges, gaps).
export type CountryLookup = (ip: string) => Country | null;

export type GeoFailure = { readonly code: "GEO_UNREADABLE"; readonly detail: string };

const Located = z.object({
    country: z.object({ iso_code: z.string().regex(/^[A-Z]{2}$/) }).optional(),
});

// mmdb-lib takes a Node Buffer (it checks with Buffer.isBuffer), so the file's bytes become one
// here, at the library's edge, as a view over the same memory.
function toNodeBuffer(bytes: Uint8Array) {
    return nodeBuffer.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function parseCountryDatabase(bytes: Uint8Array): Result<CountryLookup, GeoFailure> {
    const reader = trySync(
        () => new Reader<CountryResponse>(toNodeBuffer(bytes)),
        (cause) => ({ code: "GEO_UNREADABLE" as const, detail: describeUnknownError(cause) }),
    );
    if (!reader.ok) return reader;
    return ok((ip) => {
        const found = trySync(
            (): unknown => reader.value.get(ip),
            () => null,
        );
        if (!found.ok) return null;
        const located = Located.safeParse(found.value);
        return located.success ? (located.data.country?.iso_code ?? null) : null;
    });
}

// The file as the reload job keeps it: looked up from memory, replaced whole when the file on
// disk changes. Until a file has loaded, there is no lookup.
export type Geo = {
    readonly lookup: () => CountryLookup | null;
    readonly reload: () => Promise<Result<"loaded" | "unchanged", GeoFailure>>;
};

export function openGeo(params: { readonly path: string }): Geo {
    let current: CountryLookup | null = null;
    let version: string | null = null;
    const unreadable = (cause: unknown): GeoFailure => ({
        code: "GEO_UNREADABLE",
        detail: describeUnknownError(cause),
    });
    return {
        lookup: () => current,
        reload: async () => {
            const file = Bun.file(params.path);
            const stat = await tryAsync(() => file.stat(), unreadable);
            if (!stat.ok) return stat;
            const seen = `${stat.value.mtimeMs}:${stat.value.size}`;
            if (seen === version && current !== null) return ok("unchanged");
            const bytes = await tryAsync(async () => await file.bytes(), unreadable);
            if (!bytes.ok) return bytes;
            const parsed = parseCountryDatabase(bytes.value);
            // A broken new file leaves the last good one in use.
            if (!parsed.ok) return err(parsed.error);
            current = parsed.value;
            version = seen;
            return ok("loaded");
        },
    };
}
