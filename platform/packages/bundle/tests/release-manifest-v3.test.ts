import { expect, test } from "bun:test";
import { z } from "zod";
import {
    coreFactKeys,
    coreFactKeysIn,
    factModules,
    manifestDigest,
    parseReleaseManifest,
    parseReleaseManifestV2,
    parseReleaseManifestV3,
    toReleaseManifestBytes,
    toReleaseManifestV2Bytes,
    toReleaseManifestV3Bytes,
} from "../src/release-manifest.ts";
import { hexBytes, hexU64, readVersionedFile, readVersionedJson } from "./fixtures.ts";

// contracts/release-manifest/v3, written by native/libs/bundle/tests/release_manifest_v3_test.cpp:
// each .json states its .bin's contents, the derived manifest digest, and the core capabilities'
// facts overall and per module.

const Vector = z.strictObject({
    format: z.literal(3),
    product: z.string(),
    manifest_digest: hexBytes(32),
    facts: z.array(z.strictObject({ key: hexU64, kind: z.number().int(), module: hexU64 })),
    capabilities: z.array(
        z.strictObject({
            key: hexU64,
            level: z.enum(["optional", "core"]),
            members: z.array(hexU64),
        }),
    ),
    features: z.array(z.strictObject({ key: hexU64, tag: z.string() })),
    core_facts: z.array(hexU64),
    core_facts_by_module: z.array(z.strictObject({ module: hexU64, core_facts: z.array(hexU64) })),
});

async function readVector(name: string) {
    const bytes = new Uint8Array(await readVersionedFile("release-manifest", "v3", `${name}.bin`));
    const stated = Vector.parse(await readVersionedJson("release-manifest", "v3", `${name}.json`));
    const manifest = {
        product: stated.product,
        facts: stated.facts,
        capabilities: stated.capabilities,
        features: stated.features,
    };
    return { bytes, stated, manifest };
}

const NAMES = ["empty", "modules"];

test("each version 3 release manifest vector decodes to what it states, and encodes back", async () => {
    for (const name of NAMES) {
        const { bytes, stated, manifest } = await readVector(name);

        expect(parseReleaseManifestV3(bytes)).toEqual({ ok: true, value: manifest });
        expect(toReleaseManifestV3Bytes(manifest)).toEqual(bytes);
        expect(manifestDigest(stated.facts)).toEqual(new Uint8Array(stated.manifest_digest));
        expect(coreFactKeys(manifest)).toEqual(stated.core_facts);
    }
});

test("each version 3 vector's core facts per module are those it states", async () => {
    for (const name of NAMES) {
        const { stated, manifest } = await readVector(name);

        expect(factModules(manifest)).toEqual(
            stated.core_facts_by_module.map((each) => each.module),
        );
        for (const each of stated.core_facts_by_module) {
            expect(coreFactKeysIn(manifest, each.module)).toEqual(each.core_facts);
        }
        expect(coreFactKeysIn(manifest, 1n)).toEqual([]);
    }
});

test("version 3's parser calls version 1 and 2 bytes a version mismatch, and they it", async () => {
    const { bytes } = await readVector("modules");
    const first = toReleaseManifestBytes({ game: 730, facts: [], capabilities: [] });
    const second = toReleaseManifestV2Bytes({
        product: "cs2",
        facts: [],
        capabilities: [],
        features: [],
    });
    const mismatch = { ok: false, error: { code: "VERSION_MISMATCH" } } as const;

    expect(parseReleaseManifestV3(first)).toEqual(mismatch);
    expect(parseReleaseManifestV3(second)).toEqual(mismatch);
    expect(parseReleaseManifest(bytes)).toEqual(mismatch);
    expect(parseReleaseManifestV2(bytes)).toEqual(mismatch);
});

test("a version 3 fact naming module hash 0 is malformed", async () => {
    const { bytes } = await readVector("modules");
    // The product "cs2" ends at 10, the fact count at 14; the first fact's module at 23.
    const zero = bytes.slice();
    zero.fill(0, 23, 31);

    expect(parseReleaseManifestV3(zero)).toEqual({ ok: false, error: { code: "MALFORMED" } });
});

test("no prefix or extension of a version 3 manifest decodes", async () => {
    const { bytes } = await readVector("modules");
    const extended = new Uint8Array(bytes.byteLength + 1);
    extended.set(bytes);

    for (let size = 0; size < bytes.byteLength; size += 1) {
        expect(parseReleaseManifestV3(bytes.subarray(0, size)).ok).toBe(false);
    }
    expect(parseReleaseManifestV3(extended).ok).toBe(false);
});
