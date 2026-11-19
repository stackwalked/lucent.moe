import { expect, test } from "bun:test";
import { z } from "zod";
import {
    coreFactKeys,
    manifestDigest,
    parseReleaseManifest,
    parseReleaseManifestV2,
    toReleaseManifestBytes,
    toReleaseManifestV2Bytes,
} from "../src/release-manifest.ts";
import { hexBytes, hexU64, readVersionedFile, readVersionedJson } from "./fixtures.ts";

// contracts/release-manifest/v2, written by native/libs/bundle/tests/release_manifest_v2_test.cpp:
// each .json states its .bin's contents, the derived manifest digest and the core capabilities'
// facts.

const Vector = z.strictObject({
    format: z.literal(2),
    product: z.string(),
    manifest_digest: hexBytes(32),
    facts: z.array(z.strictObject({ key: hexU64, kind: z.number().int() })),
    capabilities: z.array(
        z.strictObject({
            key: hexU64,
            level: z.enum(["optional", "core"]),
            members: z.array(hexU64),
        }),
    ),
    features: z.array(z.strictObject({ key: hexU64, tag: z.string() })),
    core_facts: z.array(hexU64),
});

async function readVector(name: string) {
    return {
        bytes: new Uint8Array(await readVersionedFile("release-manifest", "v2", `${name}.bin`)),
        stated: Vector.parse(await readVersionedJson("release-manifest", "v2", `${name}.json`)),
    };
}

const NAMES = ["empty", "features"];

test("each version 2 release manifest vector decodes to what it states, and encodes back", async () => {
    for (const name of NAMES) {
        const { bytes, stated } = await readVector(name);
        const manifest = {
            product: stated.product,
            facts: stated.facts,
            capabilities: stated.capabilities,
            features: stated.features,
        };

        expect(parseReleaseManifestV2(bytes)).toEqual({ ok: true, value: manifest });
        expect(toReleaseManifestV2Bytes(manifest)).toEqual(bytes);
        expect(manifestDigest(stated.facts)).toEqual(new Uint8Array(stated.manifest_digest));
        expect(coreFactKeys(manifest)).toEqual(stated.core_facts);
    }
});

test("each version's parser calls the other version's bytes a version mismatch", async () => {
    const { bytes } = await readVector("features");
    const first = toReleaseManifestBytes({ game: 730, facts: [], capabilities: [] });
    const mismatch = { ok: false, error: { code: "VERSION_MISMATCH" } } as const;

    expect(parseReleaseManifest(bytes)).toEqual(mismatch);
    expect(parseReleaseManifestV2(first)).toEqual(mismatch);
});

test("a version 2 manifest with unsorted features, a bad tag or a bad product is malformed", async () => {
    const { stated } = await readVector("features");
    const valid = {
        product: stated.product,
        facts: stated.facts,
        capabilities: stated.capabilities,
        features: stated.features,
    };
    const bytes = toReleaseManifestV2Bytes(valid);
    const malformedResult = { ok: false, error: { code: "MALFORMED" } } as const;
    // The product "cs2" sits at 7 after its size at 6. The features end the bytes, each its key,
    // tag size and tag: "visuals" (16 bytes), "aim" (12), "movement.v2" (20).
    const featuresAt = bytes.byteLength - (8 + 1 + 7) - (8 + 1 + 3) - (8 + 1 + 11);
    const swapped = bytes.slice();
    swapped.set(bytes.subarray(featuresAt + 16, featuresAt + 28), featuresAt);
    swapped.set(bytes.subarray(featuresAt, featuresAt + 16), featuresAt + 12);
    const capital = bytes.slice();
    capital[featuresAt + 9] = "V".charCodeAt(0);
    const spaced = bytes.slice();
    spaced[7] = " ".charCodeAt(0);

    expect(parseReleaseManifestV2(swapped)).toEqual(malformedResult);
    expect(parseReleaseManifestV2(capital)).toEqual(malformedResult);
    expect(parseReleaseManifestV2(spaced)).toEqual(malformedResult);
});

test("no prefix or extension of a version 2 manifest decodes", async () => {
    const { bytes } = await readVector("features");
    const extended = new Uint8Array(bytes.byteLength + 1);
    extended.set(bytes);

    for (let size = 0; size < bytes.byteLength; size += 1) {
        expect(parseReleaseManifestV2(bytes.subarray(0, size)).ok).toBe(false);
    }
    expect(parseReleaseManifestV2(extended).ok).toBe(false);
});
