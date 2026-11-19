import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { z } from "zod";
import {
    type DeliveredSet,
    deliver,
    deliverAll,
    parseBundle,
    toBundleBytes,
    verifySet,
} from "../src/bundle.ts";
import { fromLiteral } from "../src/fact-set.ts";
import { leafHash, treeRoot } from "../src/merkle.ts";
import {
    entriesOf,
    hexBytes,
    hexU32,
    hexU64,
    OTHER_PUBLIC_KEY,
    readContractFile,
    readContractJson,
    SIGNER_PUBLIC_KEY,
} from "./fixtures.ts";

// contracts/fact-bundle/v1, written by native/libs/bundle/tests/vectors_test.cpp: each .json states
// what its .bin decodes to. Every implementation must produce and accept exactly these bytes.

const VectorSet = z
    .strictObject({
        game: z.number().int(),
        revision: z.number().int(),
        modules: z.array(
            z.strictObject({
                name_hash: hexU64,
                time_date_stamp: hexU32,
                size_of_image: hexU32,
            }),
        ),
        finders_commit: hexBytes(20),
        manifest_digest: hexBytes(32),
        entry_count: z.number().int(),
        merkle_root: hexBytes(32),
        signature: hexBytes(64),
        delivered: z.array(
            z.strictObject({ index: z.number().int(), key: hexU64, literal: hexU64 }),
        ),
        proof: z.array(hexBytes(32)),
    })
    .transform(
        (set): DeliveredSet => ({
            header: {
                game: set.game,
                revision: set.revision,
                modules: set.modules.map((module) => ({
                    nameHash: module.name_hash,
                    timeDateStamp: module.time_date_stamp,
                    sizeOfImage: module.size_of_image,
                })),
                findersCommit: set.finders_commit,
                manifestDigest: set.manifest_digest,
                entryCount: set.entry_count,
                merkleRoot: set.merkle_root,
                signature: set.signature,
            },
            entries: set.delivered.map((given) => ({
                index: given.index,
                entry: fromLiteral(given.key, given.literal),
            })),
            proof: set.proof,
        }),
    );

const Vector = z.strictObject({
    format: z.literal(1),
    signer_public_key: hexBytes(32),
    sets: z.array(VectorSet),
});

async function readVector(name: string) {
    return {
        bytes: await readContractFile("fact-bundle", `${name}.bin`),
        stated: Vector.parse(await readContractJson("fact-bundle", `${name}.json`)),
    };
}

const NAMES = ["full", "subset", "composite"];

test("each fact bundle vector decodes to exactly what its description states", async () => {
    for (const name of NAMES) {
        const { bytes, stated } = await readVector(name);

        expect(parseBundle(bytes)).toEqual({ ok: true, value: stated.sets });
    }
});

test("each fact bundle vector's description encodes to its bytes exactly", async () => {
    for (const name of NAMES) {
        const { bytes, stated } = await readVector(name);

        expect(toBundleBytes(stated.sets)).toEqual(new Uint8Array(bytes));
    }
});

test("every set in the vectors verifies against the vectors' signer", async () => {
    for (const name of NAMES) {
        const { bytes, stated } = await readVector(name);
        const decoded = parseBundle(bytes);
        invariant(decoded.ok, `${name} decodes`);

        expect(stated.signer_public_key).toEqual(SIGNER_PUBLIC_KEY);
        for (const set of decoded.value) {
            expect(await verifySet(set, [SIGNER_PUBLIC_KEY])).toEqual({
                ok: true,
                value: undefined,
            });
            expect(await verifySet(set, [OTHER_PUBLIC_KEY, SIGNER_PUBLIC_KEY])).toMatchObject({
                ok: true,
            });
        }
    }
});

test("no set in the vectors verifies against a key that didn't sign it", async () => {
    for (const name of NAMES) {
        const { stated } = await readVector(name);
        for (const set of stated.sets) {
            expect(await verifySet(set, [OTHER_PUBLIC_KEY])).toEqual({
                ok: false,
                error: { code: "UNTRUSTED_SIGNATURE" },
            });
            expect(await verifySet(set, [])).toMatchObject({ ok: false });
        }
    }
});

test("the complete vectors' entries hash to their signed Merkle root", async () => {
    for (const name of ["full", "composite"]) {
        const { stated } = await readVector(name);
        for (const set of stated.sets) {
            const leaves = set.entries.map((given) => leafHash(given.entry));

            expect(set.entries).toHaveLength(set.header.entryCount);
            expect(treeRoot(leaves)).toEqual(new Uint8Array(set.header.merkleRoot));
        }
    }
});

test("delivering the subset vector's keys from its complete set gives the vector's proof", async () => {
    const { bytes, stated } = await readVector("subset");
    const [subset] = stated.sets;
    invariant(subset !== undefined, "the subset vector has a set");
    const full = { header: subset.header, entries: entriesOf(subset.header.entryCount) };

    const delivered = deliver(
        full,
        subset.entries.map((given) => given.entry.key),
    );

    expect(treeRoot(full.entries.map(leafHash))).toEqual(new Uint8Array(subset.header.merkleRoot));
    expect(delivered).toEqual(subset);
    expect(toBundleBytes([delivered])).toEqual(new Uint8Array(bytes));
});

test("delivering all of the full vector's complete set gives the vector, with no proof", async () => {
    const { bytes, stated } = await readVector("full");
    const [full] = stated.sets;
    invariant(full !== undefined, "the full vector has a set");

    const delivered = deliverAll({
        header: full.header,
        entries: entriesOf(full.header.entryCount),
    });

    expect(delivered).toEqual(full);
    expect(toBundleBytes([delivered])).toEqual(new Uint8Array(bytes));
});
