import { expect, test } from "bun:test";
import { blake2b256 } from "@lucent/bundle/crypto";
import { z } from "zod";
import { parseContainerBody, toContainerBodyBytes, unpackContainer } from "../src/container.ts";
import {
    CONTAINER_CHUNK_SIZE,
    openContainerStream,
    sealContainerStream,
    toChunkAssociatedData,
} from "../src/container-stream.ts";
import {
    parseReleaseSeal,
    toReleaseSealBytes,
    toReleaseSealSignedBytes,
    verifyReleaseSeal,
} from "../src/release-seal.ts";
import { signWithSeed } from "../src/session-crypto.ts";
import {
    bigintNumber,
    hexAny,
    hexBytes,
    hexU64,
    readContractFile,
    readContractJson,
} from "./fixtures.ts";

// contracts/container/v1, contracts/container-stream/v1 and contracts/release-seal/v1, written by
// native/libs/wire/tests/container_vectors_test.cpp: each .json states its .bin's contents.

async function vector<T extends z.ZodType>(contract: string, name: string, schema: T) {
    return {
        bytes: new Uint8Array(await readContractFile(contract, `${name}.bin`)),
        stated: schema.parse(await readContractJson(contract, `${name}.json`)),
    };
}

const ContainerVector = z
    .strictObject({
        release: hexBytes(16),
        image_size: z.number().int(),
        entry_rva: z.number().int(),
        boot_rva: z.number().int(),
        boot_info_version: z.number().int(),
        pdata_rva: z.number().int(),
        pdata_size: z.number().int(),
        imports_key: hexBytes(32),
        sections: z.array(
            z.strictObject({
                rva: z.number().int(),
                mapped_size: z.number().int(),
                access: z.enum(["read", "read_write", "read_execute"]),
                data: hexAny,
            }),
        ),
        relocations: z.array(z.number().int()),
        imports: z.array(
            z.strictObject({
                module_hash: hexU64,
                function_hash: hexU64,
                slot_rva: z.number().int(),
            }),
        ),
        body: hexAny,
    })
    .transform((stated) => ({
        body: stated.body,
        container: {
            release: stated.release,
            imageSize: stated.image_size,
            entryRva: stated.entry_rva,
            bootRva: stated.boot_rva,
            bootInfoVersion: stated.boot_info_version,
            pdataRva: stated.pdata_rva,
            pdataSize: stated.pdata_size,
            importsKey: stated.imports_key,
            sections: stated.sections.map((section) => ({
                rva: section.rva,
                mappedSize: section.mapped_size,
                access: section.access,
                data: section.data,
            })),
            relocations: stated.relocations,
            imports: stated.imports.map((entry) => ({
                moduleHash: entry.module_hash,
                functionHash: entry.function_hash,
                slotRva: entry.slot_rva,
            })),
        },
    }));

test("the container vectors unpack to what they state, and their bodies encode back", async () => {
    for (const name of ["small", "empty"]) {
        const { bytes, stated } = await vector("container", name, ContainerVector);

        expect(unpackContainer(bytes)).toEqual({ ok: true, value: stated.container });
        expect(parseContainerBody(stated.body)).toEqual({ ok: true, value: stated.container });
        expect(toContainerBodyBytes(stated.container)).toEqual(stated.body);
    }
});

test("a container cut short, extended, or under another version's context doesn't unpack", async () => {
    const { bytes } = await vector("container", "small", ContainerVector);
    const later = new Uint8Array(bytes);
    later[18] = "2".charCodeAt(0);
    const extended = new Uint8Array(bytes.byteLength + 1);
    extended.set(bytes);

    expect(unpackContainer(bytes.subarray(0, bytes.byteLength - 1)).ok).toBe(false);
    expect(unpackContainer(extended)).toEqual({ ok: false, error: { code: "MALFORMED" } });
    expect(unpackContainer(later)).toEqual({ ok: false, error: { code: "VERSION_MISMATCH" } });
});

const StreamVector = z.strictObject({
    key: hexBytes(32),
    plain_size: z.number().int(),
    plain: z.literal("byte i is i mod 251"),
    nonces: z.array(hexBytes(24)),
    associated_data: z.array(hexAny),
});

function streamPlain(size: number): Uint8Array {
    return Uint8Array.from({ length: size }, (_, index) => index % 251);
}

test("the stream vectors open to their plaintext, and seal back to their bytes", async () => {
    for (const name of ["two_chunks", "empty"]) {
        const { bytes, stated } = await vector("container-stream", name, StreamVector);
        const plain = streamPlain(stated.plain_size);

        expect(openContainerStream(stated.key, bytes)).toEqual(plain);
        expect(
            sealContainerStream({ key: stated.key, container: plain, nonces: stated.nonces }),
        ).toEqual(bytes);
        stated.associated_data.forEach((associated, index) => {
            const position = index === stated.associated_data.length - 1 ? "last" : "inner";
            expect(toChunkAssociatedData(index, position)).toEqual(associated);
        });
    }
});

test("the two-chunk stream cut after its first chunk, or with a byte flipped, doesn't open", async () => {
    const { bytes, stated } = await vector("container-stream", "two_chunks", StreamVector);
    const firstChunk = bytes.subarray(0, 24 + CONTAINER_CHUNK_SIZE + 16);
    const flipped = new Uint8Array(bytes);
    flipped[100] = (flipped[100] ?? 0) ^ 1;

    expect(openContainerStream(stated.key, firstChunk)).toBeNull();
    expect(openContainerStream(stated.key, flipped)).toBeNull();
});

const SealVector = z.strictObject({
    product: z.string(),
    channel: z.enum(["stable", "alpha", "debug"]),
    number: bigintNumber,
    release: hexBytes(16),
    boot_info_version: z.number().int(),
    artifacts: z.array(
        z.strictObject({
            kind: z.enum(["container", "release_manifest", "loader", "host"]),
            digest: hexBytes(32),
        }),
    ),
    signature: hexBytes(64),
    code_public_key: hexBytes(32),
    signed_bytes: hexAny,
});

// RFC 8032's third test key, as container_fixtures.hpp names it.
const CODE_SEED = Uint8Array.fromHex(
    "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
);

test("the seal vectors decode to what they state, verify, and this side signs them the same", async () => {
    for (const name of ["module", "loader"]) {
        const { bytes, stated } = await vector("release-seal", name, SealVector);
        const seal = {
            product: stated.product,
            channel: stated.channel,
            number: stated.number,
            release: stated.release,
            bootInfoVersion: stated.boot_info_version,
            artifacts: stated.artifacts,
            signature: stated.signature,
        };

        expect(parseReleaseSeal(bytes)).toEqual({ ok: true, value: seal });
        expect(toReleaseSealBytes(seal)).toEqual(bytes);
        expect(toReleaseSealSignedBytes(seal)).toEqual(stated.signed_bytes);
        expect(await verifyReleaseSeal(bytes, stated.code_public_key)).toEqual({
            ok: true,
            value: seal,
        });
        expect(await signWithSeed(CODE_SEED, stated.signed_bytes)).toEqual(stated.signature);
    }
});

test("the module seal names the small container's digest", async () => {
    const container = await readContractFile("container", "small.bin");
    const { stated } = await vector("release-seal", "module", SealVector);

    expect(stated.artifacts[0]?.digest).toEqual(blake2b256(new Uint8Array(container)));
});

test("a seal renumbered after signing, or checked against another key, doesn't verify", async () => {
    const { bytes, stated } = await vector("release-seal", "module", SealVector);
    const renumbered = new Uint8Array(bytes);
    renumbered[37] = 8;
    const other = new Uint8Array(stated.code_public_key);
    other[0] = (other[0] ?? 0) ^ 1;

    expect(parseReleaseSeal(renumbered).ok).toBe(true);
    expect(await verifyReleaseSeal(renumbered, stated.code_public_key)).toEqual({
        ok: false,
        error: { code: "BAD_SIGNATURE" },
    });
    expect((await verifyReleaseSeal(bytes, other)).ok).toBe(false);
});
