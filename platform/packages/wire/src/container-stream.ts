import { createWriter } from "@lucent/bundle/wire";
import { invariant, trySync } from "@lucent/core/contain";
import type { CryptoRng } from "@lucent/core/rng";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { writeContext } from "./codec.ts";

// The container as a start downloads it (contracts/container-stream/v1), as
// native/libs/wire/src/container_stream.cpp seals and opens it: the packed container in 64 KiB
// chunks, each sealed with XChaCha20-Poly1305 under the start's container key with its own random
// nonce, its index and whether it is the last in its associated data, so the loader verifies while
// downloading and a cut, reordered or spliced stream fails.
//
// Version 1:
//   per chunk: nonce (24, random), ciphertext of up to 64 KiB, tag (16); every chunk but the last
//     holds exactly 64 KiB, and only an empty container has an empty last chunk.
//   associated data: context "lucent container chunk v1" (32), u32 chunk index, u8 last (0 or 1).

export const CONTAINER_CHUNK_SIZE = 64 * 1024;
export const CHUNK_NONCE_SIZE = 24;
export const CHUNK_TAG_SIZE = 16;
const SEALED_CHUNK_SIZE = CHUNK_NONCE_SIZE + CONTAINER_CHUNK_SIZE + CHUNK_TAG_SIZE;

export type ChunkPosition = "inner" | "last";

export function toChunkAssociatedData(
    index: number,
    position: ChunkPosition,
): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeContext(out, "container chunk", 1);
    out.u32(index);
    out.u8(position === "last" ? 1 : 0);
    return out.finish();
}

export function chunkCount(size: number): number {
    return Math.max(1, Math.ceil(size / CONTAINER_CHUNK_SIZE));
}

export function encryptedSize(size: number): number {
    return size + chunkCount(size) * (CHUNK_NONCE_SIZE + CHUNK_TAG_SIZE);
}

function sealChunk(params: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly index: number;
    readonly position: ChunkPosition;
    readonly plain: Uint8Array;
}): Uint8Array<ArrayBuffer> {
    const sealed = xchacha20poly1305(
        params.key,
        params.nonce,
        toChunkAssociatedData(params.index, params.position),
    ).encrypt(params.plain);
    const chunk = new Uint8Array(CHUNK_NONCE_SIZE + sealed.byteLength);
    chunk.set(params.nonce);
    chunk.set(sealed, CHUNK_NONCE_SIZE);
    return chunk;
}

// Sealed one chunk at a time as the client reads, so a large container isn't held twice.
export function toEncryptedContainerStream(params: {
    readonly key: Uint8Array;
    readonly container: Uint8Array;
    readonly rng: CryptoRng;
}): ReadableStream<Uint8Array> {
    invariant(params.key.byteLength === 32, "container key size");
    const count = chunkCount(params.container.byteLength);
    let index = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            const last = index === count - 1;
            const start = index * CONTAINER_CHUNK_SIZE;
            controller.enqueue(
                sealChunk({
                    key: params.key,
                    nonce: params.rng.fillBytes(new Uint8Array(CHUNK_NONCE_SIZE)),
                    index,
                    position: last ? "last" : "inner",
                    plain: params.container.subarray(start, start + CONTAINER_CHUNK_SIZE),
                }),
            );
            index += 1;
            if (last) controller.close();
        },
    });
}

// The whole stream at once, with the nonces given: what the vectors pin.
export function sealContainerStream(params: {
    readonly key: Uint8Array;
    readonly container: Uint8Array;
    readonly nonces: readonly Uint8Array[];
}): Uint8Array<ArrayBuffer> {
    const count = chunkCount(params.container.byteLength);
    invariant(params.nonces.length === count, "one nonce per chunk");
    const chunks = params.nonces.map((nonce, index) => {
        const start = index * CONTAINER_CHUNK_SIZE;
        return sealChunk({
            key: params.key,
            nonce,
            index,
            position: index === count - 1 ? "last" : "inner",
            plain: params.container.subarray(start, start + CONTAINER_CHUNK_SIZE),
        });
    });
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
}

// The packed container, as the loader opens it: chunk by chunk, each against its index and
// whether the stream ended right after it. Null when any chunk fails.
export function openContainerStream(key: Uint8Array, stream: Uint8Array): Uint8Array | null {
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let index = 0; ; index += 1) {
        const end = Math.min(offset + SEALED_CHUNK_SIZE, stream.byteLength);
        const position: ChunkPosition = end === stream.byteLength ? "last" : "inner";
        if (end - offset < CHUNK_NONCE_SIZE + CHUNK_TAG_SIZE) return null;
        const cipher = xchacha20poly1305(
            key,
            stream.subarray(offset, offset + CHUNK_NONCE_SIZE),
            toChunkAssociatedData(index, position),
        );
        const opened = trySync(
            () => cipher.decrypt(stream.subarray(offset + CHUNK_NONCE_SIZE, end)),
            () => null,
        );
        if (!opened.ok) return null;
        if (position === "last" && opened.value.byteLength === 0 && index !== 0) return null;
        parts.push(opened.value);
        offset = end;
        if (position === "last") break;
    }
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}
