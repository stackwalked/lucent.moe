import {
    equalBytes,
    type FormatError,
    malformed,
    type Reader,
    versionMismatch,
    type Writer,
} from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";

// The encoding every /v1 message shares, as native/libs/wire/src/codec.hpp writes it:
// little-endian fixed-width integers, nothing aligned or padded, each message opening with a
// 32-byte context naming its kind and version. Canonical: every value has one encoding, so a
// decoder that accepts bytes re-encodes them exactly.

export const CONTEXT_SIZE = 32;
export const ID_SIZE = 16;
export const MAX_PRODUCT_SIZE = 32;

const ascii = new TextEncoder();

function contextBytes(text: string): Uint8Array<ArrayBuffer> {
    const encoded = ascii.encode(text);
    invariant(encoded.byteLength < CONTEXT_SIZE, "context too long");
    const padded = new Uint8Array(CONTEXT_SIZE);
    padded.set(encoded);
    return padded;
}

// "lucent <kind> v<version>", NUL-padded to the context size.
export function writeContext(out: Writer, kind: string, version: number): void {
    out.bytes(contextBytes(`lucent ${kind} v${version}`));
}

// The same kind at another version is VERSION_MISMATCH; anything else MALFORMED.
export function readContext(
    input: Reader,
    kind: string,
    version: number,
): Result<null, FormatError> {
    if (input.remaining() < CONTEXT_SIZE) {
        return malformed();
    }
    const taken = input.bytes(CONTEXT_SIZE);
    if (equalBytes(taken, contextBytes(`lucent ${kind} v${version}`))) {
        return ok(null);
    }
    const family = ascii.encode(`lucent ${kind} v`);
    if (equalBytes(taken.subarray(0, family.byteLength), family)) {
        return versionMismatch();
    }
    return malformed();
}

export function isProduct(product: string): boolean {
    return /^[a-z0-9-]{1,32}$/.test(product);
}

// A product id: u8 length, then its bytes.
export function writeProduct(out: Writer, product: string): void {
    invariant(isProduct(product), "product id isn't valid");
    out.u8(product.length);
    out.bytes(ascii.encode(product));
}

export function readProduct(input: Reader): Result<string, FormatError> {
    if (input.remaining() < 1) {
        return malformed();
    }
    const size = input.u8();
    if (input.remaining() < size) {
        return malformed();
    }
    const product = String.fromCharCode(...input.bytes(size));
    if (!isProduct(product)) {
        return malformed();
    }
    return ok(product);
}

// Only 0 and 1; nothing when the byte is anything else. The caller has checked one byte remains.
export function readFlag(input: Reader): boolean | null {
    const value = input.u8();
    if (value > 1) {
        return null;
    }
    return value === 1;
}

export function finish<T>(input: Reader, value: T): Result<T, FormatError> {
    if (input.remaining() !== 0) {
        return malformed();
    }
    return ok(value);
}
