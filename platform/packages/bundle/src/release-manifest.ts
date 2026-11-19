import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";
import { blake2b256 } from "./crypto.ts";
import {
    createWriter,
    type FormatError,
    malformed,
    openReader,
    type Reader,
    versionMismatch,
} from "./wire.ts";

// The release manifest (contracts/release-manifest/v1), as
// native/libs/bundle/src/release_manifest.cpp reads and writes it: which facts a release's module
// links and which capabilities it groups them into. Unsigned: it only steers the server's own
// refusals (a session leaving a core capability uncovered, a fact set lacking a fact one needs),
// and a compromised server can refuse whatever it likes anyway.
//
// Version 1 on the wire, little-endian, nothing aligned or padded:
//   u32 magic "LRM1", u16 version, u32 game,
//   u32 fact count, then per fact: u64 key, u8 kind;
//   u32 capability count, then per capability: u64 key, u8 level, u32 member count, u64 keys.

// "LRM1" as a little-endian u32.
const RELEASE_MANIFEST_MAGIC = 0x314d_524c;
const RELEASE_MANIFEST_VERSION = 1;

// Sanity bounds on what the decoder accepts.
const MAX_FACTS = 1 << 20;
const MAX_CAPABILITIES = 1 << 16;

const FACT_SIZE = 8 + 1;
const CAPABILITY_FIELDS_SIZE = 8 + 1 + 4;

// One fact as the manifest lists it.
export type ManifestFact = { readonly key: bigint; readonly kind: number };

export type CapabilityLevel = "optional" | "core";

const LEVELS: readonly CapabilityLevel[] = ["optional", "core"];

export type ManifestCapability = {
    readonly key: bigint;
    readonly level: CapabilityLevel;
    // Sorted and unique, each one among the manifest's facts.
    readonly members: readonly bigint[];
};

export type ReleaseManifest = {
    readonly game: number;
    // Sorted by key, keys unique and never 0.
    readonly facts: readonly ManifestFact[];
    // Sorted by key, keys unique and never 0.
    readonly capabilities: readonly ManifestCapability[];
};

function isStrictlySorted(keys: readonly bigint[]): boolean {
    return keys.every((key, index) => index === 0 || (keys[index - 1] ?? key) < key);
}

function isCanonical(manifest: ReleaseManifest): boolean {
    const factKeys = manifest.facts.map((fact) => fact.key);
    const known = new Set(factKeys);
    return (
        isStrictlySorted(factKeys) &&
        !known.has(0n) &&
        isStrictlySorted(manifest.capabilities.map((capability) => capability.key)) &&
        manifest.capabilities.every(
            (capability) =>
                capability.key !== 0n &&
                capability.members.length > 0 &&
                isStrictlySorted(capability.members) &&
                capability.members.every((member) => known.has(member)),
        )
    );
}

// The manifest must be canonical, as its members describe; anything else is our own bug.
export function toReleaseManifestBytes(manifest: ReleaseManifest): Uint8Array<ArrayBuffer> {
    invariant(isCanonical(manifest), "release manifest isn't canonical");
    invariant(manifest.facts.length <= MAX_FACTS, "too many facts");
    invariant(manifest.capabilities.length <= MAX_CAPABILITIES, "too many capabilities");
    const out = createWriter();
    out.u32(RELEASE_MANIFEST_MAGIC);
    out.u16(RELEASE_MANIFEST_VERSION);
    out.u32(manifest.game);
    out.u32(manifest.facts.length);
    for (const fact of manifest.facts) {
        out.u64(fact.key);
        out.u8(fact.kind);
    }
    out.u32(manifest.capabilities.length);
    for (const capability of manifest.capabilities) {
        out.u64(capability.key);
        out.u8(LEVELS.indexOf(capability.level));
        out.u32(capability.members.length);
        for (const member of capability.members) {
            out.u64(member);
        }
    }
    return out.finish();
}

function readCapability(input: Reader, factCount: number): Result<ManifestCapability, FormatError> {
    if (input.remaining() < CAPABILITY_FIELDS_SIZE) {
        return malformed();
    }
    const key = input.u64();
    const level = LEVELS[input.u8()];
    const memberCount = input.u32();
    if (level === undefined) {
        return malformed();
    }
    if (memberCount > factCount || input.remaining() < memberCount * 8) {
        return malformed();
    }
    const members: bigint[] = [];
    for (let index = 0; index < memberCount; index += 1) {
        members.push(input.u64());
    }
    return ok({ key, level, members });
}

// Canonical or nothing: sorted and unique keys, never 0, every member among the facts, known
// levels, at least one member per capability, no trailing bytes. A version this build doesn't
// read is VERSION_MISMATCH; anything else MALFORMED.
export function parseReleaseManifest(bytes: Uint8Array): Result<ReleaseManifest, FormatError> {
    const input = openReader(bytes);
    if (input.remaining() < 4 + 2) {
        return malformed();
    }
    if (input.u32() !== RELEASE_MANIFEST_MAGIC) {
        return malformed();
    }
    if (input.u16() !== RELEASE_MANIFEST_VERSION) {
        return versionMismatch();
    }
    if (input.remaining() < 4 + 4) {
        return malformed();
    }
    const game = input.u32();
    const factCount = input.u32();
    if (factCount > MAX_FACTS || input.remaining() < factCount * FACT_SIZE) {
        return malformed();
    }
    const facts: ManifestFact[] = [];
    for (let index = 0; index < factCount; index += 1) {
        facts.push({ key: input.u64(), kind: input.u8() });
    }
    if (input.remaining() < 4) {
        return malformed();
    }
    const capabilityCount = input.u32();
    if (capabilityCount > MAX_CAPABILITIES) {
        return malformed();
    }
    const capabilities: ManifestCapability[] = [];
    for (let index = 0; index < capabilityCount; index += 1) {
        const capability = readCapability(input, factCount);
        if (!capability.ok) {
            return capability;
        }
        capabilities.push(capability.value);
    }
    const manifest: ReleaseManifest = { game, facts, capabilities };
    if (input.remaining() !== 0 || !isCanonical(manifest)) {
        return malformed();
    }
    return ok(manifest);
}

// BLAKE2b-256 over each fact's key and kind, sorted by key: what a release's fact sets carry as
// their manifest digest. The module computes it from its own linked facts, the generator from
// the dev build's, and a set only applies where they match.
export function manifestDigest(facts: readonly ManifestFact[]): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    for (const fact of facts) {
        out.u64(fact.key);
        out.u8(fact.kind);
    }
    return blake2b256(out.finish());
}

// Sorted and unique: every fact some core capability needs.
export function coreFactKeys(manifest: ReleaseManifest): bigint[] {
    const keys = new Set<bigint>();
    for (const capability of manifest.capabilities) {
        if (capability.level === "core") {
            for (const member of capability.members) {
                keys.add(member);
            }
        }
    }
    return [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
