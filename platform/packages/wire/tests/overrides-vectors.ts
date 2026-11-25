import { join } from "node:path";
import { createWriter } from "@lucent/bundle/wire";
import { z } from "zod";
import { toDataResponseV3Bytes } from "../src/data.ts";
import { type Overrides, toOverridesBytes, toOverridesSignedBytes } from "../src/overrides.ts";
import { signingPublicKey, signWithSeed } from "../src/session-crypto.ts";
import { bigintNumber, hexAny, hexU32, hexU64 } from "./fixtures.ts";

// What contracts/overrides/v1 and contracts/wire/v1/data_response_v3* hold: made by the TS
// encoder; native must match. `bun tests/overrides-vectors.ts` writes them; overrides.test.ts
// checks the committed files equal what this makes. Every document is signed under OVERRIDE_SEED,
// the rejects too, so a decoder refuses them for their layout and never for their signature.

export type Vector = { readonly bytes: Uint8Array; readonly json: unknown };

export const OVERRIDE_SEED = new Uint8Array(32).fill(0x4f);

const CONTRACTS = join(import.meta.dir, "..", "..", "..", "..", "contracts");

const RELEASE = new Uint8Array(16).fill(0x33);
const AIM = 0x1111n;
const ESP = 0x2222n;
const WALLHACK = 0x0c0f_fee0_0000_0001n;
const RADAR = 0x8000_0000_0000_0002n;

const key = (value: bigint) => value.toString(16).padStart(16, "0");

type Fields = Omit<Overrides, "signature">;

async function signed(fields: Fields): Promise<Overrides> {
    return {
        ...fields,
        signature: await signWithSeed(OVERRIDE_SEED, toOverridesSignedBytes(fields)),
    };
}

function toJson(overrides: Overrides, publicKey: Uint8Array) {
    return {
        public_key: publicKey.toHex(),
        release: overrides.release.toHex(),
        revision: Number(overrides.revision),
        product: overrides.product,
        features: overrides.features.map(key),
        capabilities: overrides.capabilities.map(key),
        signature: overrides.signature.toHex(),
    };
}

// Layouts the encoder refuses to write: the fields as given, signed, with `tail` after the
// signature.
async function handBuilt(params: {
    readonly context: string;
    readonly features: readonly bigint[];
    readonly capabilities: readonly bigint[];
    readonly tail?: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
    const out = createWriter();
    const context = new Uint8Array(32);
    context.set(new TextEncoder().encode(params.context));
    out.bytes(context);
    out.bytes(RELEASE);
    out.u64(3n);
    out.u8(3);
    out.bytes(new TextEncoder().encode("cs2"));
    for (const keys of [params.features, params.capabilities]) {
        out.u16(keys.length);
        for (const value of keys) {
            out.u64(value);
        }
    }
    const fields = out.finish();
    const signature = await signWithSeed(OVERRIDE_SEED, fields);
    const tail = params.tail ?? new Uint8Array();
    const bytes = new Uint8Array(fields.byteLength + signature.byteLength + tail.byteLength);
    bytes.set(fields);
    bytes.set(signature, fields.byteLength);
    bytes.set(tail, fields.byteLength + signature.byteLength);
    return bytes;
}

// The v2 vector as it is written, and as values.
const V2Json = z.strictObject({
    answers: z.number(),
    data_revision: z.number(),
    bundle: z.string(),
    unsupported: z.array(z.unknown()),
});

const V2Response = z.strictObject({
    answers: bigintNumber,
    data_revision: bigintNumber,
    bundle: hexAny,
    unsupported: z.array(
        z.strictObject({ name_hash: hexU64, time_date_stamp: hexU32, size_of_image: hexU32 }),
    ),
});

export async function overridesVectors(): Promise<Readonly<Record<string, Vector>>> {
    const publicKey = await signingPublicKey(OVERRIDE_SEED);
    const base = { release: RELEASE, product: "cs2" };
    const documents = {
        // Every switch back on: one set and cleared again took revisions 1 and 2.
        empty: await signed({ ...base, revision: 2n, features: [], capabilities: [] }),
        features: await signed({ ...base, revision: 1n, features: [ESP], capabilities: [] }),
        features_capabilities: await signed({
            ...base,
            revision: 5n,
            features: [AIM, ESP],
            capabilities: [WALLHACK, RADAR],
        }),
    };
    const rejects = {
        reject_unsorted: {
            bytes: await handBuilt({
                context: "lucent overrides v1",
                features: [ESP, AIM],
                capabilities: [],
            }),
            defect: "feature ids out of order",
        },
        reject_zero_key: {
            bytes: await handBuilt({
                context: "lucent overrides v1",
                features: [AIM],
                capabilities: [0n, RADAR],
            }),
            defect: "a capability key of 0",
        },
        reject_trailing: {
            bytes: await handBuilt({
                context: "lucent overrides v1",
                features: [AIM],
                capabilities: [],
                tail: new Uint8Array([0]),
            }),
            defect: "a byte after the signature",
        },
        reject_context: {
            bytes: await handBuilt({
                context: "lucent lease v1",
                features: [AIM],
                capabilities: [],
            }),
            defect: "another document's context",
        },
    };

    const v2Json: unknown = await Bun.file(
        join(CONTRACTS, "wire", "v1", "data_response.json"),
    ).json();
    const v2 = V2Response.parse(v2Json);
    const stated = V2Json.parse(v2Json);
    const unsupported = v2.unsupported.map((module) => ({
        nameHash: module.name_hash,
        timeDateStamp: module.time_date_stamp,
        sizeOfImage: module.size_of_image,
    }));
    const carried = toOverridesBytes(documents.features_capabilities);

    const vectors: Record<string, Vector> = {};
    for (const [name, document] of Object.entries(documents)) {
        vectors[`overrides/${name}`] = {
            bytes: toOverridesBytes(document),
            json: toJson(document, publicKey),
        };
    }
    for (const [name, reject] of Object.entries(rejects)) {
        vectors[`overrides/${name}`] = {
            bytes: reject.bytes,
            json: { public_key: publicKey.toHex(), error: "MALFORMED", defect: reject.defect },
        };
    }
    // data_response's own fields with the document after the bundle, and a first response to a
    // release that has no document.
    vectors["wire/data_response_v3"] = {
        bytes: toDataResponseV3Bytes({
            answers: v2.answers,
            dataRevision: v2.data_revision,
            bundle: v2.bundle,
            overrides: carried,
            unsupported,
        }),
        json: {
            answers: stated.answers,
            data_revision: stated.data_revision,
            bundle: stated.bundle,
            overrides: carried.toHex(),
            unsupported: stated.unsupported,
        },
    };
    vectors["wire/data_response_v3_none"] = {
        bytes: toDataResponseV3Bytes({
            answers: 0n,
            dataRevision: 0n,
            bundle: v2.bundle,
            overrides: null,
            unsupported: [],
        }),
        json: {
            answers: 0,
            data_revision: 0,
            bundle: v2.bundle.toHex(),
            overrides: null,
            unsupported: [],
        },
    };
    return vectors;
}

export function toVectorJson(json: unknown): string {
    return `${JSON.stringify(json, null, 2)}\n`;
}

// "overrides/empty" is contracts/overrides/v1/empty.*, "wire/data_response_v3" is
// contracts/wire/v1/data_response_v3.*.
export function vectorPath(name: string, extension: "bin" | "json"): string {
    const [contract = "", file = ""] = name.split("/");
    return join(CONTRACTS, contract, "v1", `${file}.${extension}`);
}

if (import.meta.main) {
    for (const [name, vector] of Object.entries(await overridesVectors())) {
        await Bun.write(vectorPath(name, "bin"), vector.bytes);
        await Bun.write(vectorPath(name, "json"), toVectorJson(vector.json));
    }
}
