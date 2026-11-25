import { expect, test } from "bun:test";
import { z } from "zod";
import { parseDataResponse, parseDataResponseV3, toDataResponseV3Bytes } from "../src/data.ts";
import { parseOverrides, toOverridesBytes, toOverridesSignedBytes } from "../src/overrides.ts";
import { signingPublicKey } from "../src/session-crypto.ts";
import { isStrictlySignedBy } from "../src/strict-signature.ts";
import { bigintNumber, hexAny, hexBytes, hexU32, hexU64 } from "./fixtures.ts";
import { OVERRIDE_SEED, overridesVectors, toVectorJson, vectorPath } from "./overrides-vectors.ts";

// contracts/overrides/v1 and contracts/wire/v1/data_response_v3*, produced by src/overrides.ts's
// and src/data.ts's encoders through overrides-vectors.ts; native must match them. The refusals
// below patch bytes at offsets written out here, so they state the layout independently of the
// encoder.

const MALFORMED = { ok: false, error: { code: "MALFORMED" } } as const;
const MISMATCH = { ok: false, error: { code: "VERSION_MISMATCH" } } as const;

const DOCUMENTS = ["empty", "features", "features_capabilities"];
const REJECTS = ["reject_unsorted", "reject_zero_key", "reject_trailing", "reject_context"];
const RESPONSES = ["data_response_v3", "data_response_v3_none"];

const Document = z
    .strictObject({
        public_key: hexBytes(32),
        release: hexBytes(16),
        revision: bigintNumber,
        product: z.string(),
        features: z.array(hexU64),
        capabilities: z.array(hexU64),
        signature: hexBytes(64),
    })
    .transform(({ public_key, ...overrides }) => ({ publicKey: public_key, overrides }));

const Reject = z.strictObject({
    public_key: hexBytes(32),
    error: z.literal("MALFORMED"),
    defect: z.string(),
});

const Response = z
    .strictObject({
        answers: bigintNumber,
        data_revision: bigintNumber,
        bundle: hexAny,
        overrides: hexAny.nullable(),
        unsupported: z.array(
            z
                .strictObject({ name_hash: hexU64, time_date_stamp: hexU32, size_of_image: hexU32 })
                .transform((module) => ({
                    nameHash: module.name_hash,
                    timeDateStamp: module.time_date_stamp,
                    sizeOfImage: module.size_of_image,
                })),
        ),
    })
    .transform(({ data_revision, ...rest }) => ({ dataRevision: data_revision, ...rest }));

async function bytesOf(name: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await Bun.file(vectorPath(name, "bin")).bytes());
}

async function jsonOf(name: string): Promise<unknown> {
    return await Bun.file(vectorPath(name, "json")).json();
}

function withByte(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const out = bytes.slice();
    out[offset] = value;
    return out;
}

test("the committed override and data response v3 vectors are what overrides-vectors.ts makes", async () => {
    const made = await overridesVectors();

    expect(Object.keys(made).sort()).toEqual(
        [
            ...[...DOCUMENTS, ...REJECTS].map((name) => `overrides/${name}`),
            ...RESPONSES.map((name) => `wire/${name}`),
        ].sort(),
    );
    for (const [name, vector] of Object.entries(made)) {
        expect(await bytesOf(name)).toEqual(new Uint8Array(vector.bytes));
        expect(await Bun.file(vectorPath(name, "json")).text()).toBe(toVectorJson(vector.json));
    }
});

test("the override vectors decode to what they state, encode back, and verify under the seed's key", async () => {
    const publicKey = await signingPublicKey(OVERRIDE_SEED);
    for (const name of DOCUMENTS) {
        const bytes = await bytesOf(`overrides/${name}`);
        const stated = Document.parse(await jsonOf(`overrides/${name}`));
        const { signature, ...fields } = stated.overrides;

        expect(stated.publicKey).toEqual(publicKey);
        expect(parseOverrides(bytes)).toEqual({ ok: true, value: stated.overrides });
        expect(toOverridesBytes(stated.overrides)).toEqual(bytes);
        expect(await isStrictlySignedBy(publicKey, toOverridesSignedBytes(fields), signature)).toBe(
            true,
        );
    }
});

test("the reject vectors are signed and still malformed", async () => {
    for (const name of REJECTS) {
        const bytes = await bytesOf(`overrides/${name}`);
        const stated = Reject.parse(await jsonOf(`overrides/${name}`));
        // The signature sits right after the fields, whatever trails it.
        const fieldsEnd =
            name === "reject_trailing" ? bytes.byteLength - 65 : bytes.byteLength - 64;

        expect(
            await isStrictlySignedBy(
                stated.public_key,
                bytes.subarray(0, fieldsEnd),
                bytes.subarray(fieldsEnd, fieldsEnd + 64),
            ),
        ).toBe(true);
        expect(parseOverrides(bytes)).toEqual(MALFORMED);
    }
});

test("no prefix or extension of an override document decodes", async () => {
    for (const name of DOCUMENTS) {
        const bytes = await bytesOf(`overrides/${name}`);
        const extended = new Uint8Array(bytes.byteLength + 1);
        extended.set(bytes);

        for (let size = 0; size < bytes.byteLength; size += 1) {
            expect(parseOverrides(bytes.subarray(0, size))).toEqual(MALFORMED);
        }
        expect(parseOverrides(extended)).toEqual(MALFORMED);
    }
});

// features_capabilities: context (32), release (16), revision at 48, product size at 56, "cs2",
// feature count at 60, features at 62 and 70, capability count at 78, capabilities at 80 and 88,
// signature at 96.
test("an override document with keys out of order, repeated or 0, or a count past its bytes, is malformed", async () => {
    const bytes = await bytesOf("overrides/features_capabilities");
    const swapped = bytes.slice();
    swapped.set(bytes.subarray(70, 78), 62);
    swapped.set(bytes.subarray(62, 70), 70);
    const repeated = bytes.slice();
    repeated.set(bytes.subarray(80, 88), 88);
    const zeroFeature = bytes.slice();
    zeroFeature.fill(0, 62, 70);

    expect(parseOverrides(swapped)).toEqual(MALFORMED);
    expect(parseOverrides(repeated)).toEqual(MALFORMED);
    expect(parseOverrides(zeroFeature)).toEqual(MALFORMED);
    for (const count of [3, 0xff]) {
        expect(parseOverrides(withByte(bytes, 60, count))).toEqual(MALFORMED);
        expect(parseOverrides(withByte(bytes, 78, count))).toEqual(MALFORMED);
    }
    expect(parseOverrides(withByte(bytes, 61, 1))).toEqual(MALFORMED);
});

test("an override document under another context is malformed, its own at v2 a version mismatch", async () => {
    const bytes = await bytesOf("overrides/empty");

    expect(parseOverrides(withByte(bytes, 18, "2".charCodeAt(0)))).toEqual(MISMATCH);
    expect(parseOverrides(withByte(bytes, 7, "O".charCodeAt(0)))).toEqual(MALFORMED);
    expect(parseOverrides(withByte(bytes, 56, 0))).toEqual(MALFORMED);
});

test("the data response v3 vectors decode to what they state, and encode back to their bytes", async () => {
    for (const name of RESPONSES) {
        const bytes = await bytesOf(`wire/${name}`);
        const stated = Response.parse(await jsonOf(`wire/${name}`));

        expect(parseDataResponseV3(bytes)).toEqual({ ok: true, value: stated });
        expect(toDataResponseV3Bytes(stated)).toEqual(bytes);
    }
    const carried = Response.parse(await jsonOf("wire/data_response_v3")).overrides;
    expect(carried).toEqual(await bytesOf("overrides/features_capabilities"));
});

test("data response v3 is v2's fields with the document after the bundle, and each version refuses the other", async () => {
    const v2 = await Bun.file(vectorPath("wire/data_response", "bin")).bytes();
    const v3 = await bytesOf("wire/data_response_v3");
    const document = await bytesOf("overrides/features_capabilities");
    const bundleEnd = 52 + new DataView(v2.buffer).getUint32(48, true);

    expect(v3.subarray(32, bundleEnd)).toEqual(v2.subarray(32, bundleEnd));
    expect(new DataView(v3.buffer).getUint32(bundleEnd, true)).toBe(document.byteLength);
    expect(v3.subarray(bundleEnd + 4, bundleEnd + 4 + document.byteLength)).toEqual(document);
    expect(v3.subarray(bundleEnd + 4 + document.byteLength)).toEqual(v2.subarray(bundleEnd));
    expect(parseDataResponse(v3)).toEqual(MISMATCH);
    expect(parseDataResponseV3(v2)).toEqual(MISMATCH);
});

test("no prefix or extension of a data response v3 decodes, nor a document size past its bytes", async () => {
    for (const name of RESPONSES) {
        const bytes = await bytesOf(`wire/${name}`);
        const extended = new Uint8Array(bytes.byteLength + 1);
        extended.set(bytes);

        for (let size = 0; size < bytes.byteLength; size += 1) {
            expect(parseDataResponseV3(bytes.subarray(0, size))).toEqual(MALFORMED);
        }
        expect(parseDataResponseV3(extended)).toEqual(MALFORMED);
    }
    const none = await bytesOf("wire/data_response_v3_none");
    const sizeAt = 52 + new DataView(none.buffer).getUint32(48, true);
    expect(parseDataResponseV3(withByte(none, sizeAt, 1))).toEqual(MALFORMED);
    expect(parseDataResponseV3(withByte(none, sizeAt + 3, 0xff))).toEqual(MALFORMED);
});
