import {
    createWriter,
    type FormatError,
    malformed,
    openReader,
    type Writer,
} from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import {
    finish,
    ID_SIZE,
    isProduct,
    readContext,
    readFlag,
    readProduct,
    writeContext,
    writeProduct,
} from "./codec.ts";
import { MODULE_NONCE_SIZE, SIGNATURE_SIZE } from "./session.ts";

// The lease and its renewal, as native/libs/wire/src/lease.cpp reads and writes them
// (POST /v1/sessions/:id/lease, inside frames both ways). The module counts the duration on its
// monotonic clock from when it sent the request the lease answers.
//
// Version 1 on the wire:
//   lease: context "lucent lease v1" (32), session id (16), device id (16), release id (16),
//     u64 sequence, module nonce (16), u32 duration in milliseconds, u64 bundle revision,
//     challenge nonce (16), u32 challenge offset, u32 challenge size, u8 product size, product,
//     u8 everything (0 or 1), u16 feature count, u64 feature ids, Ed25519 signature (64) over
//     everything before it.
//   renewal: context "lucent lease renewal v1" (32), u64 sequence, module nonce (16),
//     challenge answer (32), signals (64).

const LEASE_VERSION = 1;
const RENEWAL_VERSION = 1;

export const CHALLENGE_NONCE_SIZE = 16;
export const CHALLENGE_ANSWER_SIZE = 32;
export const SIGNALS_SIZE = 64;
export const MAX_FEATURES = 4096;

export type HashChallenge = {
    readonly nonce: Uint8Array;
    readonly offset: number;
    readonly size: number;
};

// kit::entitlements on the wire: everything, or the listed per-release keyed feature ids (sorted,
// unique, never 0). Everything lists none.
export type EntitledFeatures =
    | { readonly everything: true }
    | { readonly everything: false; readonly features: readonly bigint[] };

export type Lease = {
    readonly session: Uint8Array;
    readonly device: Uint8Array;
    readonly release: Uint8Array;
    readonly sequence: bigint;
    // The nonce of the hello or renewal this lease answers.
    readonly nonce: Uint8Array;
    readonly durationMs: number;
    readonly bundleRevision: bigint;
    readonly challenge: HashChallenge;
    readonly product: string;
    readonly entitled: EntitledFeatures;
    readonly signature: Uint8Array;
};

export type LeaseRenewal = {
    // The lease sequence asked for: the held lease's plus one.
    readonly sequence: bigint;
    readonly nonce: Uint8Array;
    readonly challengeAnswer: Uint8Array;
    // Bits and small enums, assigned in slice 3; every value is canonical.
    readonly signals: Uint8Array;
};

function featuresOf(entitled: EntitledFeatures): readonly bigint[] {
    return entitled.everything ? [] : entitled.features;
}

function isCanonical(lease: Omit<Lease, "signature">): boolean {
    const features = featuresOf(lease.entitled);
    return (
        lease.durationMs > 0 &&
        lease.durationMs <= 0xffff_ffff &&
        lease.challenge.size > 0 &&
        isProduct(lease.product) &&
        features.length <= MAX_FEATURES &&
        features.every(
            (feature, index) =>
                feature !== 0n && (index === 0 || (features[index - 1] ?? feature) < feature),
        )
    );
}

function writeLeaseFields(out: Writer, lease: Omit<Lease, "signature">): void {
    invariant(isCanonical(lease), "lease isn't canonical");
    for (const id of [lease.session, lease.device, lease.release]) {
        invariant(id.byteLength === ID_SIZE, "id size");
    }
    invariant(lease.nonce.byteLength === MODULE_NONCE_SIZE, "nonce size");
    invariant(lease.challenge.nonce.byteLength === CHALLENGE_NONCE_SIZE, "challenge nonce size");
    writeContext(out, "lease", LEASE_VERSION);
    out.bytes(lease.session);
    out.bytes(lease.device);
    out.bytes(lease.release);
    out.u64(lease.sequence);
    out.bytes(lease.nonce);
    out.u32(lease.durationMs);
    out.u64(lease.bundleRevision);
    out.bytes(lease.challenge.nonce);
    out.u32(lease.challenge.offset);
    out.u32(lease.challenge.size);
    writeProduct(out, lease.product);
    out.u8(lease.entitled.everything ? 1 : 0);
    const features = featuresOf(lease.entitled);
    out.u16(features.length);
    for (const feature of features) {
        out.u64(feature);
    }
}

// The bytes the lease key signs: everything before the signature.
export function toLeaseSignedBytes(lease: Omit<Lease, "signature">): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeLeaseFields(out, lease);
    return out.finish();
}

export function toLeaseBytes(lease: Lease): Uint8Array<ArrayBuffer> {
    invariant(lease.signature.byteLength === SIGNATURE_SIZE, "signature size");
    const out = createWriter();
    writeLeaseFields(out, lease);
    out.bytes(lease.signature);
    return out.finish();
}

const LEASE_FIXED_SIZE = 3 * ID_SIZE + 8 + MODULE_NONCE_SIZE + 4 + 8 + CHALLENGE_NONCE_SIZE + 4 + 4;

// Canonical or nothing: a non-zero duration and challenge size, a valid product id, features as
// EntitledFeatures describes, nothing trailing. It doesn't verify the signature.
export function parseLease(bytes: Uint8Array): Result<Lease, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "lease", LEASE_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < LEASE_FIXED_SIZE) {
        return malformed();
    }
    const session = input.bytes(ID_SIZE);
    const device = input.bytes(ID_SIZE);
    const release = input.bytes(ID_SIZE);
    const sequence = input.u64();
    const nonce = input.bytes(MODULE_NONCE_SIZE);
    const durationMs = input.u32();
    const bundleRevision = input.u64();
    const challenge = {
        nonce: input.bytes(CHALLENGE_NONCE_SIZE),
        offset: input.u32(),
        size: input.u32(),
    };
    const product = readProduct(input);
    if (!product.ok) {
        return product;
    }
    if (input.remaining() < 1 + 2) {
        return malformed();
    }
    const everything = readFlag(input);
    const count = input.u16();
    if (
        everything === null ||
        count > MAX_FEATURES ||
        input.remaining() < count * 8 + SIGNATURE_SIZE
    ) {
        return malformed();
    }
    const features: bigint[] = [];
    for (let index = 0; index < count; index += 1) {
        features.push(input.u64());
    }
    if (everything && count !== 0) {
        return malformed();
    }
    const lease: Lease = {
        session,
        device,
        release,
        sequence,
        nonce,
        durationMs,
        bundleRevision,
        challenge,
        product: product.value,
        entitled: everything ? { everything: true } : { everything: false, features },
        signature: input.bytes(SIGNATURE_SIZE),
    };
    if (!isCanonical(lease)) {
        return malformed();
    }
    return finish(input, lease);
}

export function toLeaseRenewalBytes(renewal: LeaseRenewal): Uint8Array<ArrayBuffer> {
    invariant(renewal.nonce.byteLength === MODULE_NONCE_SIZE, "nonce size");
    invariant(renewal.challengeAnswer.byteLength === CHALLENGE_ANSWER_SIZE, "answer size");
    invariant(renewal.signals.byteLength === SIGNALS_SIZE, "signals size");
    const out = createWriter();
    writeContext(out, "lease renewal", RENEWAL_VERSION);
    out.u64(renewal.sequence);
    out.bytes(renewal.nonce);
    out.bytes(renewal.challengeAnswer);
    out.bytes(renewal.signals);
    return out.finish();
}

export function parseLeaseRenewal(bytes: Uint8Array): Result<LeaseRenewal, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "lease renewal", RENEWAL_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 8 + MODULE_NONCE_SIZE + CHALLENGE_ANSWER_SIZE + SIGNALS_SIZE) {
        return malformed();
    }
    return finish(input, {
        sequence: input.u64(),
        nonce: input.bytes(MODULE_NONCE_SIZE),
        challengeAnswer: input.bytes(CHALLENGE_ANSWER_SIZE),
        signals: input.bytes(SIGNALS_SIZE),
    });
}
