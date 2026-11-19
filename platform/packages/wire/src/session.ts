import { blake2b256 } from "@lucent/bundle/crypto";
import {
    createWriter,
    equalBytes,
    type FormatError,
    malformed,
    openReader,
    type Reader,
    type Writer,
} from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";
import { finish, ID_SIZE, readContext, writeContext } from "./codec.ts";
import { type Frame, parseFrame, toFrameBytes } from "./frame.ts";

// How a module opens its session, as native/libs/wire/src/session.cpp reads and writes it: its
// hello (POST /v1/starts/:id/session, relayed by the loader), then the server's half of the key
// exchange signed by the lease key, and the first lease in a frame.
//
// Version 1 on the wire:
//   hello: context "lucent session hello v1" (32), module X25519 key (32), module nonce (16),
//     release id (16), u32 boot_info version, u8 image kind, u64 image base, u32 image size.
//   exchange: context "lucent session exchange v1" (32), session id (16), module X25519 key (32),
//     module nonce (16), server X25519 key (32), Ed25519 signature (64) over everything before it.
//   reply: the exchange, then a frame (server to module) running to the end.
//
// Session keys: per direction, BLAKE2b-256(context "lucent session keys v1" || direction byte ||
// shared secret || module key || server key). Unkeyed because Bun has no keyed BLAKE2b; the
// fixed-size fields after a fixed context keep every input's encoding unique.

const HELLO_VERSION = 1;
const EXCHANGE_VERSION = 1;
const KEYS_VERSION = 1;

export const MODULE_NONCE_SIZE = 16;
export const EXCHANGE_KEY_SIZE = 32;
export const SIGNATURE_SIZE = 64;

export type ImageKind = "loaded" | "mapped";

const IMAGE_KINDS: readonly ImageKind[] = ["loaded", "mapped"];

export type BootReport = {
    readonly bootInfoVersion: number;
    readonly imageKind: ImageKind;
    readonly imageBase: bigint;
    readonly imageSize: number;
};

export type SessionHello = {
    readonly moduleKey: Uint8Array;
    readonly nonce: Uint8Array;
    readonly release: Uint8Array;
    readonly boot: BootReport;
};

export type SessionExchange = {
    readonly session: Uint8Array;
    readonly moduleKey: Uint8Array;
    readonly nonce: Uint8Array;
    readonly serverKey: Uint8Array;
    readonly signature: Uint8Array;
};

export type SessionReply = {
    readonly exchange: SessionExchange;
    readonly firstLease: Frame;
};

export type SessionKeys = {
    readonly moduleToServer: Uint8Array<ArrayBuffer>;
    readonly serverToModule: Uint8Array<ArrayBuffer>;
};

const EXCHANGE_SIZE =
    32 + ID_SIZE + EXCHANGE_KEY_SIZE + MODULE_NONCE_SIZE + EXCHANGE_KEY_SIZE + SIGNATURE_SIZE;

// 2^255 - 19, little-endian: an X25519 key is canonical below it. RFC 7748 lets a decoder mask
// the top bit and reduce, so anything at or above it aliases a smaller key.
const FIELD_PRIME = (1n << 255n) - 19n;

function littleEndian(bytes: Uint8Array): bigint {
    return bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

export function isCanonicalExchangeKey(key: Uint8Array): boolean {
    return key.byteLength === EXCHANGE_KEY_SIZE && littleEndian(key) < FIELD_PRIME;
}

export function toSessionHelloBytes(hello: SessionHello): Uint8Array<ArrayBuffer> {
    invariant(isCanonicalExchangeKey(hello.moduleKey), "module key isn't canonical");
    invariant(hello.nonce.byteLength === MODULE_NONCE_SIZE, "nonce size");
    invariant(hello.release.byteLength === ID_SIZE, "release id size");
    const out = createWriter();
    writeContext(out, "session hello", HELLO_VERSION);
    out.bytes(hello.moduleKey);
    out.bytes(hello.nonce);
    out.bytes(hello.release);
    out.u32(hello.boot.bootInfoVersion);
    out.u8(IMAGE_KINDS.indexOf(hello.boot.imageKind));
    out.u64(hello.boot.imageBase);
    out.u32(hello.boot.imageSize);
    return out.finish();
}

// Canonical or nothing: a known image kind, an X25519 key below 2^255 - 19, nothing trailing.
export function parseSessionHello(bytes: Uint8Array): Result<SessionHello, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "session hello", HELLO_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < EXCHANGE_KEY_SIZE + MODULE_NONCE_SIZE + ID_SIZE + 4 + 1 + 8 + 4) {
        return malformed();
    }
    const moduleKey = input.bytes(EXCHANGE_KEY_SIZE);
    const nonce = input.bytes(MODULE_NONCE_SIZE);
    const release = input.bytes(ID_SIZE);
    const bootInfoVersion = input.u32();
    const imageKind = IMAGE_KINDS[input.u8()];
    const imageBase = input.u64();
    const imageSize = input.u32();
    if (imageKind === undefined || !isCanonicalExchangeKey(moduleKey)) {
        return malformed();
    }
    return finish(input, {
        moduleKey,
        nonce,
        release,
        boot: { bootInfoVersion, imageKind, imageBase, imageSize },
    });
}

function writeExchangeFields(out: Writer, exchange: SessionExchange): void {
    invariant(exchange.session.byteLength === ID_SIZE, "session id size");
    invariant(isCanonicalExchangeKey(exchange.moduleKey), "module key isn't canonical");
    invariant(isCanonicalExchangeKey(exchange.serverKey), "server key isn't canonical");
    invariant(exchange.nonce.byteLength === MODULE_NONCE_SIZE, "nonce size");
    writeContext(out, "session exchange", EXCHANGE_VERSION);
    out.bytes(exchange.session);
    out.bytes(exchange.moduleKey);
    out.bytes(exchange.nonce);
    out.bytes(exchange.serverKey);
}

// The bytes the lease key signs: everything before the signature.
export function toExchangeSignedBytes(exchange: SessionExchange): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeExchangeFields(out, exchange);
    return out.finish();
}

export function toSessionExchangeBytes(exchange: SessionExchange): Uint8Array<ArrayBuffer> {
    invariant(exchange.signature.byteLength === SIGNATURE_SIZE, "signature size");
    const out = createWriter();
    writeExchangeFields(out, exchange);
    out.bytes(exchange.signature);
    return out.finish();
}

function readExchange(input: Reader): Result<SessionExchange, FormatError> {
    const context = readContext(input, "session exchange", EXCHANGE_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < EXCHANGE_SIZE - 32) {
        return malformed();
    }
    const session = input.bytes(ID_SIZE);
    const moduleKey = input.bytes(EXCHANGE_KEY_SIZE);
    const nonce = input.bytes(MODULE_NONCE_SIZE);
    const serverKey = input.bytes(EXCHANGE_KEY_SIZE);
    const signature = input.bytes(SIGNATURE_SIZE);
    if (!isCanonicalExchangeKey(moduleKey) || !isCanonicalExchangeKey(serverKey)) {
        return malformed();
    }
    return ok({ session, moduleKey, nonce, serverKey, signature });
}

export function parseSessionExchange(bytes: Uint8Array): Result<SessionExchange, FormatError> {
    const input = openReader(bytes);
    const exchange = readExchange(input);
    if (!exchange.ok) {
        return exchange;
    }
    return finish(input, exchange.value);
}

export function toSessionReplyBytes(reply: SessionReply): Uint8Array<ArrayBuffer> {
    invariant(reply.firstLease.header.direction === "server_to_module", "first lease direction");
    invariant(equalBytes(reply.firstLease.header.session, reply.exchange.session), "session");
    const exchange = toSessionExchangeBytes(reply.exchange);
    const frame = toFrameBytes(reply.firstLease);
    const out = new Uint8Array(exchange.byteLength + frame.byteLength);
    out.set(exchange);
    out.set(frame, exchange.byteLength);
    return out;
}

export function parseSessionReply(bytes: Uint8Array): Result<SessionReply, FormatError> {
    const input = openReader(bytes);
    const exchange = readExchange(input);
    if (!exchange.ok) {
        return exchange;
    }
    const firstLease = parseFrame(input.bytes(input.remaining()));
    if (!firstLease.ok) {
        return firstLease;
    }
    const header = firstLease.value.header;
    if (
        header.direction !== "server_to_module" ||
        !equalBytes(header.session, exchange.value.session)
    ) {
        return malformed();
    }
    return ok({ exchange: exchange.value, firstLease: firstLease.value });
}

function deriveKey(
    direction: number,
    shared: Uint8Array,
    moduleKey: Uint8Array,
    serverKey: Uint8Array,
) {
    const out = createWriter();
    writeContext(out, "session keys", KEYS_VERSION);
    out.u8(direction);
    out.bytes(shared);
    out.bytes(moduleKey);
    out.bytes(serverKey);
    return blake2b256(out.finish());
}

export function deriveSessionKeys(params: {
    readonly shared: Uint8Array;
    readonly moduleKey: Uint8Array;
    readonly serverKey: Uint8Array;
}): SessionKeys {
    invariant(params.shared.byteLength === 32, "shared secret size");
    return {
        moduleToServer: deriveKey(1, params.shared, params.moduleKey, params.serverKey),
        serverToModule: deriveKey(2, params.shared, params.moduleKey, params.serverKey),
    };
}
