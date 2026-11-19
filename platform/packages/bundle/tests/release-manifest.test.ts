import { expect, test } from "bun:test";
import {
    coreFactKeys,
    type ManifestFact,
    parseReleaseManifest,
    toReleaseManifestBytes,
} from "../src/release-manifest.ts";
import { createWriter } from "../src/wire.ts";

// The refusals native/libs/bundle/tests/release_manifest_test.cpp checks, from bytes laid out by
// hand, so they state the wire format independently of the encoder, which refuses to write
// anything that isn't canonical.

type RawCapability = { key: bigint; level: number; members: bigint[] };

type RawManifest = {
    magic: number;
    version: number;
    game: number;
    facts: ManifestFact[];
    capabilities: RawCapability[];
};

function bytesOf(raw: RawManifest): Uint8Array {
    const out = createWriter();
    out.u32(raw.magic);
    out.u16(raw.version);
    out.u32(raw.game);
    out.u32(raw.facts.length);
    for (const fact of raw.facts) {
        out.u64(fact.key);
        out.u8(fact.kind);
    }
    out.u32(raw.capabilities.length);
    for (const capability of raw.capabilities) {
        out.u64(capability.key);
        out.u8(capability.level);
        out.u32(capability.members.length);
        for (const member of capability.members) {
            out.u64(member);
        }
    }
    return out.finish();
}

// Canonical: two facts, one core capability over both.
function valid(): RawManifest {
    return {
        magic: 0x314d_524c,
        version: 1,
        game: 730,
        facts: [
            { key: 0x10n, kind: 1 },
            { key: 0x20n, kind: 5 },
        ],
        capabilities: [{ key: 0xc1n, level: 1, members: [0x10n, 0x20n] }],
    };
}

function errorOf(raw: RawManifest): string | null {
    const decoded = parseReleaseManifest(bytesOf(raw));
    return decoded.ok ? null : decoded.error.code;
}

test("a canonical release manifest decodes to what was laid out, and encodes back to it", () => {
    const bytes = bytesOf(valid());

    const decoded = parseReleaseManifest(bytes);

    expect(decoded).toEqual({
        ok: true,
        value: {
            game: 730,
            facts: valid().facts,
            capabilities: [{ key: 0xc1n, level: "core", members: [0x10n, 0x20n] }],
        },
    });
    expect(decoded.ok && toReleaseManifestBytes(decoded.value)).toEqual(new Uint8Array(bytes));
});

test("the core facts are every core capability's members, once each, and no optional one's", () => {
    const manifest = {
        game: 1,
        facts: [0x10n, 0x20n, 0x30n, 0x40n].map((key) => ({ key, kind: 0 })),
        capabilities: [
            { key: 1n, level: "core", members: [0x20n, 0x30n] },
            { key: 2n, level: "optional", members: [0x40n] },
            { key: 3n, level: "core", members: [0x10n, 0x30n] },
        ],
    } as const;

    expect(coreFactKeys(manifest)).toEqual([0x10n, 0x20n, 0x30n]);
});

test("a manifest with unsorted or duplicate facts is malformed", () => {
    const unsorted = valid();
    unsorted.facts = [
        { key: 0x20n, kind: 5 },
        { key: 0x10n, kind: 1 },
    ];
    const duplicate = valid();
    duplicate.facts = [
        { key: 0x10n, kind: 1 },
        { key: 0x10n, kind: 1 },
    ];
    duplicate.capabilities = [{ key: 0xc1n, level: 1, members: [0x10n] }];

    expect(errorOf(unsorted)).toBe("MALFORMED");
    expect(errorOf(duplicate)).toBe("MALFORMED");
});

test("a capability member missing from the facts list is malformed", () => {
    const missing = valid();
    missing.capabilities = [{ key: 0xc1n, level: 1, members: [0x10n, 0x30n] }];

    expect(errorOf(missing)).toBe("MALFORMED");
});

test("a capability with unsorted, duplicate or no members is malformed", () => {
    for (const members of [[0x20n, 0x10n], [0x10n, 0x10n], []]) {
        const raw = valid();
        raw.capabilities = [{ key: 0xc1n, level: 1, members }];

        expect(errorOf(raw)).toBe("MALFORMED");
    }
});

test("a capability with more members than the manifest has facts is malformed", () => {
    const raw = valid();
    raw.capabilities = [{ key: 0xc1n, level: 1, members: [0x10n, 0x20n, 0x30n] }];

    expect(errorOf(raw)).toBe("MALFORMED");
});

test("unsorted or duplicate capabilities are malformed", () => {
    const unsorted = valid();
    unsorted.capabilities = [
        { key: 0xc2n, level: 0, members: [0x10n] },
        { key: 0xc1n, level: 0, members: [0x20n] },
    ];
    const duplicate = valid();
    duplicate.capabilities = [
        { key: 0xc1n, level: 0, members: [0x10n] },
        { key: 0xc1n, level: 1, members: [0x20n] },
    ];

    expect(errorOf(unsorted)).toBe("MALFORMED");
    expect(errorOf(duplicate)).toBe("MALFORMED");
});

test("a capability level this build doesn't know is malformed", () => {
    const unknown = valid();
    unknown.capabilities = [{ key: 0xc1n, level: 2, members: [0x10n, 0x20n] }];

    expect(errorOf(unknown)).toBe("MALFORMED");
});

test("a key of 0 names no fact and no capability, and is malformed", () => {
    const zeroFact = valid();
    zeroFact.facts = [
        { key: 0n, kind: 1 },
        { key: 0x20n, kind: 5 },
    ];
    zeroFact.capabilities = [{ key: 0xc1n, level: 1, members: [0n, 0x20n] }];
    const zeroCapability = valid();
    zeroCapability.capabilities = [{ key: 0n, level: 1, members: [0x10n, 0x20n] }];

    expect(errorOf(zeroFact)).toBe("MALFORMED");
    expect(errorOf(zeroCapability)).toBe("MALFORMED");
});

test("trailing bytes after a canonical manifest are malformed", () => {
    const decoded = parseReleaseManifest(new Uint8Array([...bytesOf(valid()), 0]));

    expect(decoded).toEqual({ ok: false, error: { code: "MALFORMED" } });
});

test("a manifest cut short anywhere is malformed", () => {
    const bytes = bytesOf(valid());

    for (let length = 0; length < bytes.byteLength; length += 1) {
        expect(parseReleaseManifest(bytes.subarray(0, length))).toEqual({
            ok: false,
            error: { code: "MALFORMED" },
        });
    }
});

test("a wrong magic is malformed, an unknown version a version mismatch", () => {
    const wrongMagic = valid();
    wrongMagic.magic = 0x3153_464c;
    const nextVersion = valid();
    nextVersion.version = 2;

    expect(errorOf(wrongMagic)).toBe("MALFORMED");
    expect(errorOf(nextVersion)).toBe("VERSION_MISMATCH");
    expect(parseReleaseManifest(bytesOf(nextVersion).subarray(0, 6))).toEqual({
        ok: false,
        error: { code: "VERSION_MISMATCH" },
    });
});
