import { expect, test } from "bun:test";
import { z } from "zod";
import {
    parseModuleManifest,
    parseReleaseManifestV3,
    parseReleaseManifestV4,
    toReleaseManifestV2Bytes,
    toReleaseManifestV4Bytes,
} from "../src/release-manifest.ts";
import { hexU64, readVersionedFile } from "./fixtures.ts";
import {
    releaseManifestV4Vectors,
    toVectorJson,
    vectorPath,
} from "./release-manifest-v4-vectors.ts";

// contracts/release-manifest/v4, produced by src/release-manifest.ts's encoder through
// release-manifest-v4-vectors.ts; native must match them.

const MALFORMED = { ok: false, error: { code: "MALFORMED" } } as const;
const MISMATCH = { ok: false, error: { code: "VERSION_MISMATCH" } } as const;

const Vector = z
    .strictObject({
        format: z.literal(4),
        product: z.string(),
        facts: z.array(z.strictObject({ key: hexU64, kind: z.number().int(), module: hexU64 })),
        capabilities: z.array(
            z.strictObject({
                key: hexU64,
                level: z.enum(["optional", "core"]),
                members: z.array(hexU64),
            }),
        ),
        features: z.array(z.strictObject({ key: hexU64, tag: z.string() })),
        data_response: z.union([z.literal(2), z.literal(3)]),
    })
    .transform(({ format: _, data_response, ...rest }) => ({
        ...rest,
        dataResponse: data_response,
    }));

async function bytesOf(name: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await Bun.file(vectorPath(name, "bin")).bytes());
}

test("the committed version 4 release manifest vectors are what the generator makes", async () => {
    const made = await releaseManifestV4Vectors();

    expect(Object.keys(made).sort()).toEqual(["empty", "modules", "reject_data_response"]);
    for (const [name, vector] of Object.entries(made)) {
        expect(await bytesOf(name)).toEqual(new Uint8Array(vector.bytes));
        expect(await Bun.file(vectorPath(name, "json")).text()).toBe(toVectorJson(vector.json));
    }
});

test("each version 4 vector decodes to what it states, encodes back, and is its version 3 vector plus one byte", async () => {
    for (const name of ["empty", "modules"]) {
        const bytes = await bytesOf(name);
        const stated = Vector.parse(await Bun.file(vectorPath(name, "json")).json());
        const v3 = new Uint8Array(await readVersionedFile("release-manifest", "v3", `${name}.bin`));

        expect(parseReleaseManifestV4(bytes)).toEqual({ ok: true, value: stated });
        expect(parseModuleManifest(bytes)).toEqual({ ok: true, value: stated });
        expect(toReleaseManifestV4Bytes(stated)).toEqual(bytes);
        expect(bytes.subarray(6, -1)).toEqual(v3.subarray(6));
        expect(bytes[bytes.byteLength - 1]).toBe(stated.dataResponse);
    }
});

test("a version 4 manifest's last byte is a data response version of 2 or 3, and nothing follows it", async () => {
    const modules = await bytesOf("modules");
    const withLast = (value: number) => {
        const out = modules.slice();
        out[out.byteLength - 1] = value;
        return out;
    };
    const extended = new Uint8Array(modules.byteLength + 1);
    extended.set(modules);
    extended[modules.byteLength] = 3;

    expect(parseReleaseManifestV4(await bytesOf("reject_data_response"))).toEqual(MALFORMED);
    for (const value of [0, 1, 4, 0xff]) {
        expect(parseReleaseManifestV4(withLast(value))).toEqual(MALFORMED);
        expect(parseModuleManifest(withLast(value))).toEqual(MALFORMED);
    }
    expect(parseReleaseManifestV4(withLast(2)).ok).toBe(true);
    expect(parseReleaseManifestV4(modules.subarray(0, -1))).toEqual(MALFORMED);
    expect(parseReleaseManifestV4(extended)).toEqual(MALFORMED);
    for (let size = 0; size < modules.byteLength; size += 1) {
        expect(parseReleaseManifestV4(modules.subarray(0, size)).ok).toBe(false);
    }
});

test("a module release's manifest is version 4, or version 3 read as data response 2", async () => {
    const v3 = new Uint8Array(await readVersionedFile("release-manifest", "v3", "modules.bin"));
    const v3Parsed = parseReleaseManifestV3(v3);
    const v2 = toReleaseManifestV2Bytes({
        product: "cs2",
        facts: [],
        capabilities: [],
        features: [],
    });

    expect(v3Parsed.ok).toBe(true);
    if (!v3Parsed.ok) return;
    expect(parseModuleManifest(v3)).toEqual({
        ok: true,
        value: { ...v3Parsed.value, dataResponse: 2 },
    });
    expect(parseReleaseManifestV4(v3)).toEqual(MISMATCH);
    expect(parseReleaseManifestV3(await bytesOf("modules"))).toEqual(MISMATCH);
    expect(parseModuleManifest(v2)).toEqual(MISMATCH);
});
