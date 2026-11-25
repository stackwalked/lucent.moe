import {
    createWriter,
    type FormatError,
    malformed,
    openReader,
    type Reader,
    type Writer,
} from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import {
    finish,
    ID_SIZE,
    isProduct,
    readContext,
    readProduct,
    writeContext,
    writeProduct,
} from "./codec.ts";
import { SIGNATURE_SIZE } from "./session.ts";

// The override document (contracts/overrides/v1): the features and capabilities staff forced off
// on one module release, signed with the online override key (OVERRIDE_SIGNING_KEY). One per
// release, not per session; data response v3 carries it. The module accepts only a revision at or
// above the highest it has seen, so an older document replayed can't turn a switch back on. An
// empty document means every switch is back on. Native has no codec for it yet: the vectors are
// this side's, and native must match them.
//
// Version 1 on the wire:
//   context "lucent overrides v1" (32), release id (16), u64 revision, u8 product size, product,
//   u16 feature count, u64 feature ids, u16 capability count, u64 capability keys (each list
//   sorted ascending, unique, never 0), Ed25519 signature (64) over everything before it.

const VERSION = 1;

const KEY_SIZE = 8;
const MAX_KEYS = 0xffff;

export type Overrides = {
    readonly release: Uint8Array;
    // The release's document revision, raised by every switch that changes something.
    readonly revision: bigint;
    readonly product: string;
    // The release's keyed feature ids that are off; sorted, unique, never 0.
    readonly features: readonly bigint[];
    // The release manifest's capability keys that are off; sorted, unique, never 0.
    readonly capabilities: readonly bigint[];
    readonly signature: Uint8Array;
};

// Sorted ascending without repeats, never 0, as many as a u16 counts.
export function isOverrideKeyList(keys: readonly bigint[]): boolean {
    return (
        keys.length <= MAX_KEYS &&
        keys.every((key, index) => key !== 0n && (index === 0 || (keys[index - 1] ?? key) < key))
    );
}

function writeKeys(out: Writer, keys: readonly bigint[]): void {
    out.u16(keys.length);
    for (const key of keys) {
        out.u64(key);
    }
}

function writeFields(out: Writer, overrides: Omit<Overrides, "signature">): void {
    invariant(overrides.release.byteLength === ID_SIZE, "release id size");
    invariant(isProduct(overrides.product), "product id isn't valid");
    invariant(isOverrideKeyList(overrides.features), "features aren't sorted, unique and non-zero");
    invariant(
        isOverrideKeyList(overrides.capabilities),
        "capabilities aren't sorted, unique and non-zero",
    );
    writeContext(out, "overrides", VERSION);
    out.bytes(overrides.release);
    out.u64(overrides.revision);
    writeProduct(out, overrides.product);
    writeKeys(out, overrides.features);
    writeKeys(out, overrides.capabilities);
}

// The bytes the override key signs: everything before the signature.
export function toOverridesSignedBytes(
    overrides: Omit<Overrides, "signature">,
): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeFields(out, overrides);
    return out.finish();
}

export function toOverridesBytes(overrides: Overrides): Uint8Array<ArrayBuffer> {
    invariant(overrides.signature.byteLength === SIGNATURE_SIZE, "signature size");
    const out = createWriter();
    writeFields(out, overrides);
    out.bytes(overrides.signature);
    return out.finish();
}

// A count and that many keys, or null when the count overruns what is left before the signature
// or the keys aren't canonical.
function readKeys(input: Reader): bigint[] | null {
    if (input.remaining() < 2) {
        return null;
    }
    const count = input.u16();
    if (input.remaining() < count * KEY_SIZE + SIGNATURE_SIZE) {
        return null;
    }
    const keys: bigint[] = [];
    for (let index = 0; index < count; index += 1) {
        keys.push(input.u64());
    }
    return isOverrideKeyList(keys) ? keys : null;
}

// Canonical or nothing: a valid product id, each list sorted with unique non-zero keys, a
// signature's worth of bytes after them and nothing trailing. It doesn't verify the signature.
export function parseOverrides(bytes: Uint8Array): Result<Overrides, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "overrides", VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < ID_SIZE + 8) {
        return malformed();
    }
    const release = input.bytes(ID_SIZE);
    const revision = input.u64();
    const product = readProduct(input);
    if (!product.ok) {
        return product;
    }
    const features = readKeys(input);
    if (features === null) {
        return malformed();
    }
    const capabilities = readKeys(input);
    if (capabilities === null) {
        return malformed();
    }
    return finish(input, {
        release,
        revision,
        product: product.value,
        features,
        capabilities,
        signature: input.bytes(SIGNATURE_SIZE),
    });
}
