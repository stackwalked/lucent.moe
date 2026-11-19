import { DIGEST_SIZE, SIGNATURE_SIZE } from "@lucent/bundle/crypto";
import { createWriter, type FormatError, malformed, openReader } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { finish, ID_SIZE, readContext, readProduct, writeContext, writeProduct } from "./codec.ts";
import type { Channel } from "./start.ts";
import { isStrictlySignedBy } from "./strict-signature.ts";

// The release seal (contracts/release-seal/v1), as native/libs/wire/src/release_seal.cpp reads
// and writes it: a release's artifacts and their BLAKE2b-256 digests, with its number, signed by
// the offline code key. A client accepts only the highest number it has seen signed for a product
// and channel.
//
// Version 1:
//   context "lucent release seal v1" (32), u8 product size, product, u8 channel, u64 number,
//   release id (16), u32 boot_info version, u8 artifact count, per artifact: u8 kind,
//   digest (32); then the code key's Ed25519 signature (64) over everything before it.

const VERSION = 1;
const ARTIFACT_SIZE = 1 + DIGEST_SIZE;

const CHANNELS: readonly Channel[] = ["stable", "alpha", "debug"];

export type ArtifactKind = "container" | "release_manifest" | "loader" | "host";

const KIND_CODES: Readonly<Record<ArtifactKind, number>> = {
    container: 1,
    release_manifest: 2,
    loader: 3,
    host: 4,
};

function kindOf(code: number): ArtifactKind | null {
    switch (code) {
        case 1:
            return "container";
        case 2:
            return "release_manifest";
        case 3:
            return "loader";
        case 4:
            return "host";
        default:
            return null;
    }
}

// A module's release has exactly these, in this order; the loader's the second pair.
const MODULE_KINDS: readonly ArtifactKind[] = ["container", "release_manifest"];
const LOADER_KINDS: readonly ArtifactKind[] = ["loader", "host"];

export type ReleaseArtifact = {
    readonly kind: ArtifactKind;
    readonly digest: Uint8Array;
};

export type ReleaseSeal = {
    readonly product: string;
    readonly channel: Channel;
    readonly number: bigint;
    readonly release: Uint8Array;
    readonly bootInfoVersion: number;
    readonly artifacts: readonly ReleaseArtifact[];
    readonly signature: Uint8Array;
};

export type SealError = FormatError | { readonly code: "BAD_SIGNATURE" };

function isKnownSet(artifacts: readonly ReleaseArtifact[]): boolean {
    const kinds = artifacts.map((artifact) => artifact.kind);
    const same = (wanted: readonly ArtifactKind[]) =>
        kinds.length === wanted.length && kinds.every((kind, index) => kind === wanted[index]);
    return same(MODULE_KINDS) || same(LOADER_KINDS);
}

export function isModuleSeal(seal: ReleaseSeal): boolean {
    return seal.artifacts[0]?.kind === "container";
}

export function digestOf(seal: ReleaseSeal, kind: ArtifactKind): Uint8Array | null {
    return seal.artifacts.find((artifact) => artifact.kind === kind)?.digest ?? null;
}

function isCanonical(seal: Omit<ReleaseSeal, "signature">): boolean {
    return (
        seal.number > 0n &&
        seal.number <= 0xffff_ffff_ffff_ffffn &&
        seal.release.byteLength === ID_SIZE &&
        seal.artifacts.every((artifact) => artifact.digest.byteLength === DIGEST_SIZE) &&
        isKnownSet(seal.artifacts)
    );
}

export function toReleaseSealSignedBytes(
    seal: Omit<ReleaseSeal, "signature">,
): Uint8Array<ArrayBuffer> {
    invariant(isCanonical(seal), "release seal isn't canonical");
    const out = createWriter();
    writeContext(out, "release seal", VERSION);
    writeProduct(out, seal.product);
    out.u8(CHANNELS.indexOf(seal.channel));
    out.u64(seal.number);
    out.bytes(seal.release);
    out.u32(seal.bootInfoVersion);
    out.u8(seal.artifacts.length);
    for (const artifact of seal.artifacts) {
        out.u8(KIND_CODES[artifact.kind]);
        out.bytes(artifact.digest);
    }
    return out.finish();
}

export function toReleaseSealBytes(seal: ReleaseSeal): Uint8Array<ArrayBuffer> {
    invariant(seal.signature.byteLength === SIGNATURE_SIZE, "signature size");
    const signed = toReleaseSealSignedBytes(seal);
    const out = new Uint8Array(signed.byteLength + SIGNATURE_SIZE);
    out.set(signed);
    out.set(seal.signature, signed.byteLength);
    return out;
}

// Canonical or nothing; the signature isn't checked here.
export function parseReleaseSeal(bytes: Uint8Array): Result<ReleaseSeal, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "release seal", VERSION);
    if (!context.ok) return context;
    const product = readProduct(input);
    if (!product.ok) return product;
    if (input.remaining() < 1 + 8 + ID_SIZE + 4 + 1) return malformed();
    const channel = CHANNELS[input.u8()];
    const number = input.u64();
    const release = input.bytes(ID_SIZE);
    const bootInfoVersion = input.u32();
    const count = input.u8();
    if (channel === undefined || count * ARTIFACT_SIZE + SIGNATURE_SIZE > input.remaining()) {
        return malformed();
    }
    const artifacts: ReleaseArtifact[] = [];
    for (let index = 0; index < count; index += 1) {
        const kind = kindOf(input.u8());
        const digest = input.bytes(DIGEST_SIZE);
        if (kind === null) return malformed();
        artifacts.push({ kind, digest });
    }
    const signature = input.bytes(SIGNATURE_SIZE);
    const seal = {
        product: product.value,
        channel,
        number,
        release,
        bootInfoVersion,
        artifacts,
        signature,
    };
    if (!isCanonical(seal)) return malformed();
    return finish(input, seal);
}

// Parses and checks the signature strictly against the offline code key.
export async function verifyReleaseSeal(
    bytes: Uint8Array,
    codeKey: Uint8Array,
): Promise<Result<ReleaseSeal, SealError>> {
    const seal = parseReleaseSeal(bytes);
    if (!seal.ok) return seal;
    const signed = toReleaseSealSignedBytes(seal.value);
    if (!(await isStrictlySignedBy(codeKey, signed, seal.value.signature))) {
        return err({ code: "BAD_SIGNATURE" });
    }
    return ok(seal.value);
}
