import { invariant } from "@lucent/core/contain";
import { DIGEST_SIZE } from "./crypto.ts";
import { createWriter } from "./wire.ts";

// A fact set as native/libs/bundle/include/lucent/bundle/fact_set.hpp describes it, version 1.

// "LFS1" and "LFB1" as little-endian u32s.
export const FACT_SET_MAGIC = 0x3153_464c;
export const BUNDLE_MAGIC = 0x3142_464c;
export const FORMAT_VERSION = 1;

// Sanity bounds on what the decoder accepts.
export const MAX_MODULES = 64;
export const MAX_ENTRIES = 1 << 20;
export const MAX_SETS = 256;

export const FINDERS_COMMIT_SIZE = 20;

// One game module build a fact set is keyed by. The name is hashed so no module name ships.
export type ModuleKey = {
    readonly nameHash: bigint;
    readonly timeDateStamp: number;
    readonly sizeOfImage: number;
};

// A fact's payload, tagged so later versions can carry more than a value. Version 1 knows only
// literals: an 8-byte value, used as is.
export type Payload = { readonly tag: "literal"; readonly value: bigint };

export const PAYLOAD_TAGS = { literal: 0 } as const;
export const LITERAL_SIZE = 8;

// One fact; a Merkle leaf.
export type FactEntry = { readonly key: bigint; readonly payload: Payload };

export function fromLiteral(key: bigint, value: bigint): FactEntry {
    return { key, payload: { tag: "literal", value } };
}

// Everything the signature covers, then the signature.
export type FactSetHeader = {
    readonly game: number;
    readonly revision: number;
    // Sorted and unique: every module build that shaped the values.
    readonly modules: readonly ModuleKey[];
    readonly findersCommit: Uint8Array;
    readonly manifestDigest: Uint8Array;
    readonly entryCount: number;
    readonly merkleRoot: Uint8Array;
    readonly signature: Uint8Array;
};

// A complete, signed fact set: what the generator writes and the server stores.
export type FactSet = {
    readonly header: FactSetHeader;
    // Sorted by key, keys unique.
    readonly entries: readonly FactEntry[];
};

export function compareModules(left: ModuleKey, right: ModuleKey): number {
    if (left.nameHash !== right.nameHash) {
        return left.nameHash < right.nameHash ? -1 : 1;
    }
    if (left.timeDateStamp !== right.timeDateStamp) {
        return left.timeDateStamp - right.timeDateStamp;
    }
    return left.sizeOfImage - right.sizeOfImage;
}

// The bytes the signature covers: the header up to, not including, the signature.
export function toSignedBytes(header: FactSetHeader): Uint8Array<ArrayBuffer> {
    invariant(header.findersCommit.byteLength === FINDERS_COMMIT_SIZE, "finders commit size");
    invariant(header.manifestDigest.byteLength === DIGEST_SIZE, "manifest digest size");
    invariant(header.merkleRoot.byteLength === DIGEST_SIZE, "merkle root size");
    const out = createWriter();
    out.u32(FACT_SET_MAGIC);
    out.u16(FORMAT_VERSION);
    out.u16(header.modules.length);
    out.u32(header.game);
    out.u32(header.revision);
    for (const module of header.modules) {
        out.u64(module.nameHash);
        out.u32(module.timeDateStamp);
        out.u32(module.sizeOfImage);
    }
    out.bytes(header.findersCommit);
    out.bytes(header.manifestDigest);
    out.u32(header.entryCount);
    out.bytes(header.merkleRoot);
    return out.finish();
}
