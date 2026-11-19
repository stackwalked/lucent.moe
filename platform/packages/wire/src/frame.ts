import {
    createWriter,
    type FormatError,
    malformed,
    openReader,
    type Writer,
} from "@lucent/bundle/wire";
import { invariant, trySync } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { finish, ID_SIZE, readContext, writeContext } from "./codec.ts";

// The session's frame, as native/libs/wire/src/frame.cpp reads and writes it: everything between
// module and server after the key exchange, sealed with XChaCha20-Poly1305 under the direction's
// session key. A receiver accepts a frame only when its sequence is above the highest it has
// accepted in that direction. The nonce is random, so a server that loses its counter still never
// repeats one under a key.
//
// Version 1 on the wire:
//   context "lucent frame v1" (32), session id (16), u8 direction, u64 sequence,
//   nonce (24), ciphertext, tag (16).
// The associated data is everything before the nonce; the ciphertext runs to the tag.
//
// Sealed and opened with @noble/ciphers' XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha-03), the
// construction Monocypher's crypto_aead_lock is, checked against the same vectors.

const FRAME_VERSION = 1;

export const NONCE_SIZE = 24;
export const TAG_SIZE = 16;
export const MAX_FRAME_PLAIN_SIZE = 1 << 20;

export type Direction = "module_to_server" | "server_to_module";

const DIRECTIONS: Record<Direction, number> = { module_to_server: 1, server_to_module: 2 };

function directionOf(value: number): Direction | null {
    if (value === 1) {
        return "module_to_server";
    }
    if (value === 2) {
        return "server_to_module";
    }
    return null;
}

export type FrameHeader = {
    readonly session: Uint8Array;
    readonly direction: Direction;
    readonly sequence: bigint;
};

export type Frame = {
    readonly header: FrameHeader;
    readonly nonce: Uint8Array;
    // The ciphertext, then the tag.
    readonly sealed: Uint8Array;
};

function writeHeader(out: Writer, header: FrameHeader): void {
    invariant(header.session.byteLength === ID_SIZE, "session id size");
    writeContext(out, "frame", FRAME_VERSION);
    out.bytes(header.session);
    out.u8(DIRECTIONS[header.direction]);
    out.u64(header.sequence);
}

export function toAssociatedData(header: FrameHeader): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeHeader(out, header);
    return out.finish();
}

export function toFrameBytes(frame: Frame): Uint8Array<ArrayBuffer> {
    invariant(frame.nonce.byteLength === NONCE_SIZE, "nonce size");
    invariant(frame.sealed.byteLength >= TAG_SIZE, "no room for the tag");
    invariant(frame.sealed.byteLength - TAG_SIZE <= MAX_FRAME_PLAIN_SIZE, "frame too large");
    const out = createWriter();
    writeHeader(out, frame.header);
    out.bytes(frame.nonce);
    out.bytes(frame.sealed);
    return out.finish();
}

// Canonical or nothing: a known direction, a tag at least, a plaintext within the bound.
export function parseFrame(bytes: Uint8Array): Result<Frame, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "frame", FRAME_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < ID_SIZE + 1 + 8 + NONCE_SIZE) {
        return malformed();
    }
    const session = input.bytes(ID_SIZE);
    const direction = directionOf(input.u8());
    const sequence = input.u64();
    const nonce = input.bytes(NONCE_SIZE);
    const sealedSize = input.remaining();
    if (
        direction === null ||
        sealedSize < TAG_SIZE ||
        sealedSize - TAG_SIZE > MAX_FRAME_PLAIN_SIZE
    ) {
        return malformed();
    }
    const sealed = input.bytes(sealedSize);
    return finish(input, { header: { session, direction, sequence }, nonce, sealed });
}

// What sealFrame needs: the header the AEAD authenticates, a nonce never used before under the key
// (random: see above), and the plaintext.
export type FrameContents = {
    readonly header: FrameHeader;
    readonly nonce: Uint8Array;
    readonly plain: Uint8Array;
};

export function sealFrame(key: Uint8Array, contents: FrameContents): Frame {
    invariant(key.byteLength === 32, "key size");
    invariant(contents.nonce.byteLength === NONCE_SIZE, "nonce size");
    invariant(contents.plain.byteLength <= MAX_FRAME_PLAIN_SIZE, "frame too large");
    const cipher = xchacha20poly1305(key, contents.nonce, toAssociatedData(contents.header));
    return {
        header: contents.header,
        nonce: contents.nonce,
        sealed: cipher.encrypt(contents.plain),
    };
}

export type OpenError = { readonly code: "UNAUTHENTIC" };

// The plaintext, when the frame was sealed under this key with exactly this header. The caller
// wipes it (fill(0)) once used: it may hold bundle data.
export function openFrame(key: Uint8Array, frame: Frame): Result<Uint8Array, OpenError> {
    invariant(key.byteLength === 32, "key size");
    const cipher = xchacha20poly1305(key, frame.nonce, toAssociatedData(frame.header));
    return trySync(
        () => cipher.decrypt(frame.sealed),
        () => ({ code: "UNAUTHENTIC" }) as const,
    );
}
