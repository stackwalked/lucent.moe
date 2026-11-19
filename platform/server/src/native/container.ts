import { createWriter } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { CryptoRng } from "@lucent/core/rng";
import { writeContext } from "@lucent/wire/codec";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

// A start's module container, encrypted to that start: 64 KiB chunks, each sealed with
// XChaCha20-Poly1305 under the start's container key, its index and whether it is the last in its
// associated data, so the loader verifies while downloading and a cut or reordered stream fails.
// The container itself is opaque here until its contract and post-link writer exist.
//
// Until contracts/ has it, the stream as this server writes it:
//   per chunk: nonce (24, random), ciphertext of up to 64 KiB, tag (16); every chunk but the last
//     holds exactly 64 KiB, and an empty container is one empty last chunk.
//   associated data: context "lucent container chunk v1" (32), u32 chunk index, u8 last (0 or 1).

export const CONTAINER_CHUNK_SIZE = 64 * 1024;
export const CHUNK_NONCE_SIZE = 24;
export const CHUNK_TAG_SIZE = 16;

export function toChunkAssociatedData(
    index: number,
    position: "inner" | "last",
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
            const plain = params.container.subarray(start, start + CONTAINER_CHUNK_SIZE);
            const nonce = params.rng.fillBytes(new Uint8Array(CHUNK_NONCE_SIZE));
            const sealed = xchacha20poly1305(
                params.key,
                nonce,
                toChunkAssociatedData(index, last ? "last" : "inner"),
            ).encrypt(plain);
            const chunk = new Uint8Array(CHUNK_NONCE_SIZE + sealed.byteLength);
            chunk.set(nonce);
            chunk.set(sealed, CHUNK_NONCE_SIZE);
            controller.enqueue(chunk);
            index += 1;
            if (last) controller.close();
        },
    });
}
