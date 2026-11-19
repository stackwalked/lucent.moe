import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { type DeliveredSet, parseBundle, toBundleBytes, verifySet } from "../src/bundle.ts";
import { blake2b256 } from "../src/crypto.ts";
import { fromLiteral } from "../src/fact-set.ts";
import { leafHash, proofFor, rootFrom, treeRoot } from "../src/merkle.ts";
import { entriesOf, readContractFile, SIGNER_PUBLIC_KEY } from "./fixtures.ts";

// The refusals native/libs/bundle/src/bundle.cpp makes, checked on the committed vectors with one
// thing changed. The subset vector is one set over nine entries delivering two (indices 2 and 7)
// with five proof hashes; the composite vector is one set over three modules delivering all three
// entries. Offsets below are into those bytes.

const SUBSET = await readContractFile("fact-bundle", "subset.bin");
const COMPOSITE = await readContractFile("fact-bundle", "composite.bin");

const BUNDLE_VERSION = 4;
const SET_COUNT = 6;
const SET_MAGIC = 8;
const SET_VERSION = 12;
const MODULE_COUNT = 14;
// One module: 24 + 16 + 20 + 32 bytes in.
const SUBSET_ENTRY_COUNT = 92;
const SUBSET_PRESENT = 192;
const SUBSET_FIRST_TAG = 196 + 12;
const SUBSET_SECOND_INDEX = 218;
const SUBSET_PROOF_COUNT = 240;

function patched(bytes: Uint8Array, offset: number, values: readonly number[]): Uint8Array {
    const copy = new Uint8Array(bytes);
    copy.set(values, offset);
    return copy;
}

function decodedSubset(): DeliveredSet {
    const decoded = parseBundle(SUBSET);
    invariant(decoded.ok, "the subset vector decodes");
    const [set] = decoded.value;
    invariant(set !== undefined, "the subset vector has a set");
    return set;
}

const MALFORMED = { ok: false, error: { code: "MALFORMED" } } as const;
const VERSION_MISMATCH = { ok: false, error: { code: "VERSION_MISMATCH" } } as const;

test("a bundle with a byte too many is malformed", () => {
    expect(parseBundle(new Uint8Array([...SUBSET, 0]))).toEqual(MALFORMED);
});

test("a bundle cut short anywhere is malformed", () => {
    for (let length = 0; length < SUBSET.byteLength; length += 1) {
        expect(parseBundle(SUBSET.subarray(0, length))).toEqual(MALFORMED);
    }
});

test("another bundle or set version is a version mismatch, another magic malformed", () => {
    expect(parseBundle(patched(SUBSET, BUNDLE_VERSION, [2]))).toEqual(VERSION_MISMATCH);
    expect(parseBundle(patched(SUBSET, SET_VERSION, [2]))).toEqual(VERSION_MISMATCH);
    // Version mismatch wins over the rest being missing: nothing after it is read.
    expect(parseBundle(patched(SUBSET, BUNDLE_VERSION, [2]).subarray(0, 6))).toEqual(
        VERSION_MISMATCH,
    );
    expect(parseBundle(patched(SUBSET, 0, [0]))).toEqual(MALFORMED);
    expect(parseBundle(patched(SUBSET, SET_MAGIC, [0]))).toEqual(MALFORMED);
});

test("more sets than a bundle may hold are malformed", () => {
    expect(parseBundle(patched(SUBSET, SET_COUNT, [0x01, 0x01]))).toEqual(MALFORMED);
});

test("a set with no modules, or more than a set may name, is malformed", () => {
    expect(parseBundle(patched(SUBSET, MODULE_COUNT, [0]))).toEqual(MALFORMED);
    expect(parseBundle(patched(SUBSET, MODULE_COUNT, [65]))).toEqual(MALFORMED);
});

test("modules out of order or repeated are malformed", () => {
    const decoded = parseBundle(COMPOSITE);
    invariant(decoded.ok, "the composite vector decodes");
    const [set] = decoded.value;
    invariant(set !== undefined, "the composite vector has a set");
    const [first, second, third] = set.header.modules;
    invariant(first !== undefined && second !== undefined && third !== undefined, "three modules");
    const withModules = (modules: DeliveredSet["header"]["modules"]): DeliveredSet => ({
        ...set,
        header: { ...set.header, modules },
    });

    expect(parseBundle(toBundleBytes([withModules([first, second, third])]))).toMatchObject({
        ok: true,
    });
    expect(parseBundle(toBundleBytes([withModules([second, first, third])]))).toEqual(MALFORMED);
    expect(parseBundle(toBundleBytes([withModules([first, first, third])]))).toEqual(MALFORMED);
});

test("entries out of order, or of an unknown payload kind or length, are malformed", () => {
    const set = decodedSubset();
    const [first, second] = set.entries;
    invariant(first !== undefined && second !== undefined, "two entries");

    expect(parseBundle(toBundleBytes([{ ...set, entries: [second, first] }]))).toEqual(MALFORMED);
    expect(parseBundle(toBundleBytes([{ ...set, entries: [first, first] }]))).toEqual(MALFORMED);
    // Indices in order with keys not, and the other way round.
    const keySwapped = [
        { index: first.index, entry: second.entry },
        { index: second.index, entry: first.entry },
    ];
    const indexSwapped = [
        { index: second.index, entry: first.entry },
        { index: first.index, entry: second.entry },
    ];
    expect(parseBundle(toBundleBytes([{ ...set, entries: keySwapped }]))).toEqual(MALFORMED);
    expect(parseBundle(toBundleBytes([{ ...set, entries: indexSwapped }]))).toEqual(MALFORMED);
    expect(parseBundle(patched(SUBSET, SUBSET_FIRST_TAG, [9]))).toEqual(MALFORMED);
    expect(parseBundle(patched(SUBSET, SUBSET_FIRST_TAG + 1, [7]))).toEqual(MALFORMED);
});

test("an entry index past the set's entry count is malformed", () => {
    expect(parseBundle(patched(SUBSET, SUBSET_SECOND_INDEX, [9]))).toEqual(MALFORMED);
    expect(parseBundle(patched(SUBSET, SUBSET_SECOND_INDEX, [8]))).toMatchObject({ ok: true });
});

test("more delivered entries or proof hashes than the set could need are malformed", () => {
    expect(parseBundle(patched(SUBSET, SUBSET_PRESENT, [10]))).toEqual(MALFORMED);
    expect(parseBundle(patched(SUBSET, SUBSET_PROOF_COUNT, [11]))).toEqual(MALFORMED);
});

test("an entry count past the decoder's bound is malformed", () => {
    expect(parseBundle(patched(SUBSET, SUBSET_ENTRY_COUNT, [0x01, 0x00, 0x10, 0x00]))).toEqual(
        MALFORMED,
    );
});

test("a changed value, key, proof hash or header field fails verification", async () => {
    const honest = decodedSubset();
    const [first, second] = honest.entries;
    const [firstHash, ...restOfProof] = honest.proof;
    invariant(first !== undefined && second !== undefined && firstHash !== undefined, "shape");
    const flipped = new Uint8Array(firstHash);
    flipped[0] = (flipped[0] ?? 0) ^ 1;

    const changedValue: DeliveredSet = {
        ...honest,
        entries: [{ index: first.index, entry: fromLiteral(first.entry.key, 0xbadn) }, second],
    };
    const changedKey: DeliveredSet = {
        ...honest,
        entries: [
            { index: first.index, entry: fromLiteral(first.entry.key ^ 1n, 0xa002n) },
            second,
        ],
    };
    const changedProof: DeliveredSet = { ...honest, proof: [flipped, ...restOfProof] };
    const changedRevision: DeliveredSet = {
        ...honest,
        header: { ...honest.header, revision: honest.header.revision + 1 },
    };

    expect(await verifySet(honest, [SIGNER_PUBLIC_KEY])).toMatchObject({ ok: true });
    expect(await verifySet(changedValue, [SIGNER_PUBLIC_KEY])).toEqual({
        ok: false,
        error: { code: "UNPROVEN" },
    });
    expect(await verifySet(changedKey, [SIGNER_PUBLIC_KEY])).toMatchObject({ ok: false });
    expect(await verifySet(changedProof, [SIGNER_PUBLIC_KEY])).toMatchObject({ ok: false });
    expect(await verifySet(changedRevision, [SIGNER_PUBLIC_KEY])).toEqual({
        ok: false,
        error: { code: "UNTRUSTED_SIGNATURE" },
    });
});

test("a proof with a hash missing or one left over fails verification", async () => {
    const honest = decodedSubset();
    const shortProof: DeliveredSet = { ...honest, proof: honest.proof.slice(0, -1) };
    const longProof: DeliveredSet = { ...honest, proof: [...honest.proof, ...honest.proof] };

    expect(await verifySet(shortProof, [SIGNER_PUBLIC_KEY])).toEqual({
        ok: false,
        error: { code: "UNPROVEN" },
    });
    expect(await verifySet(longProof, [SIGNER_PUBLIC_KEY])).toEqual({
        ok: false,
        error: { code: "UNPROVEN" },
    });
});

// RFC 6962's Merkle Tree Hash by its own definition: split at the largest power of two below the
// size. An independent reference for the bottom-up tree.
function referenceRoot(leaves: readonly Uint8Array[]): Uint8Array {
    if (leaves.length === 0) {
        return blake2b256(new Uint8Array(0));
    }
    const [only] = leaves;
    if (leaves.length === 1 && only !== undefined) {
        return only;
    }
    let split = 1;
    while (split * 2 < leaves.length) {
        split *= 2;
    }
    const left = referenceRoot(leaves.slice(0, split));
    const right = referenceRoot(leaves.slice(split));
    return blake2b256(new Uint8Array([1, ...left, ...right]));
}

test("the bottom-up tree has RFC 6962's root for every size", () => {
    for (let size = 0; size <= 17; size += 1) {
        const leaves = entriesOf(size).map(leafHash);

        expect(treeRoot(leaves)).toEqual(new Uint8Array(referenceRoot(leaves)));
    }
});

test("every subset of a set's entries proves against its root, and only with its own proof", () => {
    for (let size = 0; size <= 8; size += 1) {
        const leaves = entriesOf(size).map(leafHash);
        const root = treeRoot(leaves);
        for (let subset = 0; subset < 1 << size; subset += 1) {
            const known = leaves.flatMap((hash, index) =>
                (subset >> index) & 1 ? [{ index, hash }] : [],
            );
            const proof = proofFor(
                leaves,
                known.map((leaf) => leaf.index),
            );

            expect(rootFrom(size, known, proof)).toEqual({ ok: true, value: root });
            if (proof.length > 0) {
                expect(rootFrom(size, known, proof.slice(1))).toMatchObject({ ok: false });
            }
            expect(rootFrom(size, known, [...proof, root])).toMatchObject({ ok: false });
        }
    }
});
