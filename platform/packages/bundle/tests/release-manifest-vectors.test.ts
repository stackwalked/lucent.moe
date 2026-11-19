import { expect, test } from "bun:test";
import { z } from "zod";
import {
    coreFactKeys,
    manifestDigest,
    parseReleaseManifest,
    toReleaseManifestBytes,
} from "../src/release-manifest.ts";
import { hexBytes, hexU64, readContractFile, readContractJson } from "./fixtures.ts";

// contracts/release-manifest/v1, written by native/libs/bundle/tests/release_manifest_vectors_test.cpp:
// each .json states its .bin's contents, the derived manifest digest and the core capabilities'
// facts.

const Vector = z.strictObject({
    format: z.literal(1),
    game: z.number().int(),
    manifest_digest: hexBytes(32),
    facts: z.array(z.strictObject({ key: hexU64, kind: z.number().int() })),
    capabilities: z.array(
        z.strictObject({
            key: hexU64,
            level: z.enum(["optional", "core"]),
            members: z.array(hexU64),
        }),
    ),
    core_facts: z.array(hexU64),
});

async function readVector(name: string) {
    return {
        bytes: await readContractFile("release-manifest", `${name}.bin`),
        stated: Vector.parse(await readContractJson("release-manifest", `${name}.json`)),
    };
}

const NAMES = ["empty", "capabilities"];

test("each release manifest vector decodes to what its description states", async () => {
    for (const name of NAMES) {
        const { bytes, stated } = await readVector(name);

        expect(parseReleaseManifest(bytes)).toEqual({
            ok: true,
            value: { game: stated.game, facts: stated.facts, capabilities: stated.capabilities },
        });
    }
});

test("each release manifest vector's description encodes to its bytes exactly", async () => {
    for (const name of NAMES) {
        const { bytes, stated } = await readVector(name);

        expect(toReleaseManifestBytes(stated)).toEqual(new Uint8Array(bytes));
    }
});

test("each release manifest vector has the stated manifest digest and core facts", async () => {
    for (const name of NAMES) {
        const { stated } = await readVector(name);

        expect(manifestDigest(stated.facts)).toEqual(new Uint8Array(stated.manifest_digest));
        expect(coreFactKeys(stated)).toEqual(stated.core_facts);
    }
});
