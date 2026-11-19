import { invariant, unreachable } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { blake2b256, DIGEST_SIZE } from "./crypto.ts";
import { type FactEntry, LITERAL_SIZE, PAYLOAD_TAGS } from "./fact-set.ts";
import { createWriter } from "./wire.ts";

// The RFC 6962 tree shape (split at the largest power of two below the size), built bottom-up:
// each level pairs its nodes left to right and carries an odd last node up unchanged, which is
// the same tree. Leaves hash as H(0x00 ‖ leaf), interior nodes as H(0x01 ‖ left ‖ right), so no
// interior hash can pass for a leaf. A port of native/libs/bundle/src/merkle.cpp; the proof's
// hash order is part of the wire format.

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

export function leafHash(entry: FactEntry): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    out.u8(LEAF_PREFIX);
    out.u64(entry.key);
    switch (entry.payload.tag) {
        case "literal":
            out.u8(PAYLOAD_TAGS.literal);
            out.u8(LITERAL_SIZE);
            out.u64(entry.payload.value);
            break;
        default:
            unreachable(entry.payload.tag, "payload tag");
    }
    return blake2b256(out.finish());
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(1 + 2 * DIGEST_SIZE);
    bytes[0] = NODE_PREFIX;
    bytes.set(left, 1);
    bytes.set(right, 1 + DIGEST_SIZE);
    return blake2b256(bytes);
}

function at<T>(items: readonly T[], position: number): T {
    const item = items[position];
    invariant(item !== undefined, "tree position out of range");
    return item;
}

function parentLevel(level: readonly Uint8Array[]): Uint8Array[] {
    const parents: Uint8Array[] = [];
    for (let position = 0; position + 1 < level.length; position += 2) {
        parents.push(nodeHash(at(level, position), at(level, position + 1)));
    }
    if (level.length % 2 === 1) {
        parents.push(at(level, level.length - 1));
    }
    return parents;
}

// H() over nothing for an empty tree.
export function treeRoot(leaves: readonly Uint8Array[]): Uint8Array {
    if (leaves.length === 0) {
        return blake2b256(new Uint8Array(0));
    }
    let level: readonly Uint8Array[] = leaves;
    while (level.length > 1) {
        level = parentLevel(level);
    }
    return at(level, 0);
}

// The sibling hashes a verifier holding only `present` (sorted leaf indices) asks for, level by
// level from the leaves up, left to right within a level. With nothing present, the proof is
// the root itself.
export function proofFor(leaves: readonly Uint8Array[], present: readonly number[]): Uint8Array[] {
    if (leaves.length === 0) {
        return [];
    }
    if (present.length === 0) {
        return [treeRoot(leaves)];
    }
    const proof: Uint8Array[] = [];
    let level: readonly Uint8Array[] = leaves;
    let known: readonly number[] = present;
    while (level.length > 1) {
        const parents: number[] = [];
        for (let index = 0; index < known.length; index += 1) {
            const position = at(known, index);
            const sibling = position ^ 1;
            const isSiblingKnown = known[index + 1] === sibling;
            if (sibling < level.length && !isSiblingKnown) {
                proof.push(at(level, sibling));
            }
            if (isSiblingKnown) {
                index += 1;
            }
            parents.push(Math.floor(position / 2));
        }
        known = parents;
        level = parentLevel(level);
    }
    return proof;
}

export type KnownLeaf = { readonly index: number; readonly hash: Uint8Array };

export type ProofError = { readonly code: "PROOF_MISMATCH" };

// The root a proof and the known leaves (sorted, indices below `leafCount`) lead to. Refused when
// the proof has too few hashes or any left over.
export function rootFrom(
    leafCount: number,
    known: readonly KnownLeaf[],
    proof: readonly Uint8Array[],
): Result<Uint8Array, ProofError> {
    const mismatch = err({ code: "PROOF_MISMATCH" });
    if (leafCount === 0) {
        if (known.length !== 0 || proof.length !== 0) {
            return mismatch;
        }
        return ok(blake2b256(new Uint8Array(0)));
    }
    if (known.length === 0) {
        if (proof.length !== 1) {
            return mismatch;
        }
        return ok(at(proof, 0));
    }
    let level: readonly KnownLeaf[] = known;
    let used = 0;
    for (let width = leafCount; width > 1; width = Math.ceil(width / 2)) {
        const parents: KnownLeaf[] = [];
        for (let index = 0; index < level.length; index += 1) {
            const node = at(level, index);
            const sibling = node.index ^ 1;
            const next = level[index + 1];
            let parent: Uint8Array;
            if (sibling >= width) {
                parent = node.hash;
            } else if (next !== undefined && next.index === sibling) {
                parent = nodeHash(node.hash, next.hash);
                index += 1;
            } else {
                const other = proof[used];
                if (other === undefined) {
                    return mismatch;
                }
                used += 1;
                parent =
                    node.index % 2 === 0 ? nodeHash(node.hash, other) : nodeHash(other, node.hash);
            }
            parents.push({ index: Math.floor(node.index / 2), hash: parent });
        }
        level = parents;
    }
    if (used !== proof.length) {
        return mismatch;
    }
    return ok(at(level, 0).hash);
}
