import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { DIGEST_SIZE, isSignedBy, SIGNATURE_SIZE } from "./crypto.ts";
import {
    BUNDLE_MAGIC,
    compareModules,
    FACT_SET_MAGIC,
    type FactEntry,
    type FactSet,
    type FactSetHeader,
    FINDERS_COMMIT_SIZE,
    FORMAT_VERSION,
    LITERAL_SIZE,
    MAX_ENTRIES,
    MAX_MODULES,
    MAX_SETS,
    type ModuleKey,
    PAYLOAD_TAGS,
    toSignedBytes,
} from "./fact-set.ts";
import { leafHash, proofFor, rootFrom } from "./merkle.ts";
import {
    createWriter,
    equalBytes,
    type FormatError,
    malformed,
    openReader,
    type Reader,
    versionMismatch,
    type Writer,
} from "./wire.ts";

// The fact bundle (contracts/fact-bundle/v1), as native/libs/bundle/src/bundle.cpp reads and
// writes it: "LFB1", u16 version, u16 set count, then each set's signed header, signature,
// delivered entries and proof hashes.

// An entry as delivered, with its position in the complete set's sorted order.
export type DeliveredEntry = { readonly index: number; readonly entry: FactEntry };

// A fact set as a bundle carries it: the signed header, the entries given to this session, and
// the hashes that let them be checked against the signed root without the rest.
export type DeliveredSet = {
    readonly header: FactSetHeader;
    // Sorted by index, which is also key order.
    readonly entries: readonly DeliveredEntry[];
    readonly proof: readonly Uint8Array[];
};

const PREAMBLE_SIZE = 4 + 2;
const MODULE_SIZE = 8 + 4 + 4;
const ENTRY_FIELDS_SIZE = 4 + 8 + 1 + 1;

// Only the entries with these keys, and the proof for them. Keys the set doesn't hold are ignored.
export function deliver(full: FactSet, keys: Iterable<bigint>): DeliveredSet {
    const wanted = new Set(keys);
    const entries: DeliveredEntry[] = [];
    full.entries.forEach((entry, index) => {
        if (wanted.has(entry.key)) {
            entries.push({ index, entry });
        }
    });
    const proof = proofFor(
        full.entries.map(leafHash),
        entries.map((given) => given.index),
    );
    return { header: full.header, entries, proof };
}

// Every entry; the proof is empty.
export function deliverAll(full: FactSet): DeliveredSet {
    return {
        header: full.header,
        entries: full.entries.map((entry, index) => ({ index, entry })),
        proof: [],
    };
}

function writeSet(out: Writer, set: DeliveredSet): void {
    invariant(set.header.signature.byteLength === SIGNATURE_SIZE, "signature size");
    out.bytes(toSignedBytes(set.header));
    out.bytes(set.header.signature);
    out.u32(set.entries.length);
    for (const given of set.entries) {
        out.u32(given.index);
        out.u64(given.entry.key);
        out.u8(PAYLOAD_TAGS[given.entry.payload.tag]);
        out.u8(LITERAL_SIZE);
        out.u64(given.entry.payload.value);
    }
    out.u32(set.proof.length);
    for (const hash of set.proof) {
        invariant(hash.byteLength === DIGEST_SIZE, "proof hash size");
        out.bytes(hash);
    }
}

export function toBundleBytes(sets: readonly DeliveredSet[]): Uint8Array<ArrayBuffer> {
    invariant(sets.length <= MAX_SETS, "too many sets for one bundle");
    const out = createWriter();
    out.u32(BUNDLE_MAGIC);
    out.u16(FORMAT_VERSION);
    out.u16(sets.length);
    for (const set of sets) {
        writeSet(out, set);
    }
    return out.finish();
}

// The magic and format version every top-level structure starts with.
function readPreamble(input: Reader, magic: number): Result<void, FormatError> {
    if (input.remaining() < PREAMBLE_SIZE) {
        return malformed();
    }
    if (input.u32() !== magic) {
        return malformed();
    }
    if (input.u16() !== FORMAT_VERSION) {
        return versionMismatch();
    }
    return ok(undefined);
}

function readModules(input: Reader, count: number): Result<ModuleKey[], FormatError> {
    const modules: ModuleKey[] = [];
    for (let index = 0; index < count; index += 1) {
        const module: ModuleKey = {
            nameHash: input.u64(),
            timeDateStamp: input.u32(),
            sizeOfImage: input.u32(),
        };
        const previous = modules.at(-1);
        if (previous !== undefined && compareModules(previous, module) >= 0) {
            return malformed();
        }
        modules.push(module);
    }
    return ok(modules);
}

function readHeader(input: Reader): Result<FactSetHeader, FormatError> {
    const preamble = readPreamble(input, FACT_SET_MAGIC);
    if (!preamble.ok) {
        return preamble;
    }
    if (input.remaining() < 2) {
        return malformed();
    }
    const moduleCount = input.u16();
    if (moduleCount === 0 || moduleCount > MAX_MODULES) {
        return malformed();
    }
    const fixedSize =
        4 + 4 + moduleCount * MODULE_SIZE + FINDERS_COMMIT_SIZE + DIGEST_SIZE + 4 + DIGEST_SIZE;
    if (input.remaining() < fixedSize + SIGNATURE_SIZE) {
        return malformed();
    }
    const game = input.u32();
    const revision = input.u32();
    const modules = readModules(input, moduleCount);
    if (!modules.ok) {
        return modules;
    }
    const findersCommit = input.bytes(FINDERS_COMMIT_SIZE);
    const manifestDigest = input.bytes(DIGEST_SIZE);
    const entryCount = input.u32();
    if (entryCount > MAX_ENTRIES) {
        return malformed();
    }
    return ok({
        game,
        revision,
        modules: modules.value,
        findersCommit,
        manifestDigest,
        entryCount,
        merkleRoot: input.bytes(DIGEST_SIZE),
        signature: input.bytes(SIGNATURE_SIZE),
    });
}

function readEntry(input: Reader): Result<DeliveredEntry, FormatError> {
    if (input.remaining() < ENTRY_FIELDS_SIZE) {
        return malformed();
    }
    const index = input.u32();
    const key = input.u64();
    const tag = input.u8();
    const length = input.u8();
    // Version 1 knows literals only.
    if (tag !== PAYLOAD_TAGS.literal || length !== LITERAL_SIZE) {
        return malformed();
    }
    if (input.remaining() < LITERAL_SIZE) {
        return malformed();
    }
    return ok({ index, entry: { key, payload: { tag: "literal", value: input.u64() } } });
}

function readSet(input: Reader): Result<DeliveredSet, FormatError> {
    const header = readHeader(input);
    if (!header.ok) {
        return header;
    }
    const { entryCount } = header.value;
    if (input.remaining() < 4) {
        return malformed();
    }
    const present = input.u32();
    if (present > entryCount) {
        return malformed();
    }
    const entries: DeliveredEntry[] = [];
    for (let count = 0; count < present; count += 1) {
        const given = readEntry(input);
        if (!given.ok) {
            return given;
        }
        const previous = entries.at(-1);
        const isInOrder =
            previous === undefined ||
            (previous.index < given.value.index && previous.entry.key < given.value.entry.key);
        if (given.value.index >= entryCount || !isInOrder) {
            return malformed();
        }
        entries.push(given.value);
    }
    if (input.remaining() < 4) {
        return malformed();
    }
    const proofCount = input.u32();
    if (proofCount > entryCount + 1 || input.remaining() < proofCount * DIGEST_SIZE) {
        return malformed();
    }
    const proof: Uint8Array[] = [];
    for (let count = 0; count < proofCount; count += 1) {
        proof.push(input.bytes(DIGEST_SIZE));
    }
    return ok({ header: header.value, entries, proof });
}

// Canonical or nothing: exact lengths, sorted and unique modules, keys and indices, known payload
// kinds, no trailing bytes. A format this build doesn't read is VERSION_MISMATCH, anywhere in the
// bundle; anything else MALFORMED. Says nothing about signatures or proofs: `verifySet` does.
export function parseBundle(bytes: Uint8Array): Result<DeliveredSet[], FormatError> {
    const input = openReader(bytes);
    const preamble = readPreamble(input, BUNDLE_MAGIC);
    if (!preamble.ok) {
        return preamble;
    }
    if (input.remaining() < 2) {
        return malformed();
    }
    const setCount = input.u16();
    if (setCount > MAX_SETS) {
        return malformed();
    }
    const sets: DeliveredSet[] = [];
    for (let index = 0; index < setCount; index += 1) {
        const set = readSet(input);
        if (!set.ok) {
            return set;
        }
        sets.push(set.value);
    }
    if (input.remaining() !== 0) {
        return malformed();
    }
    return ok(sets);
}

export type VerifyError = { readonly code: "UNTRUSTED_SIGNATURE" } | { readonly code: "UNPROVEN" };

// Signed by one of `trusted` (raw Ed25519 public keys), and every delivered entry provably under
// the signed root. Says nothing about whether the set fits a release's manifest or the modules a
// session reported.
export async function verifySet(
    set: DeliveredSet,
    trusted: readonly Uint8Array[],
): Promise<Result<void, VerifyError>> {
    const covered = toSignedBytes(set.header);
    const verdicts = await Promise.all(
        trusted.map((signer) => isSignedBy(signer, covered, set.header.signature)),
    );
    if (!verdicts.includes(true)) {
        return err({ code: "UNTRUSTED_SIGNATURE" });
    }
    const known = set.entries.map((given) => ({
        index: given.index,
        hash: leafHash(given.entry),
    }));
    const root = rootFrom(set.header.entryCount, known, set.proof);
    if (!root.ok || !equalBytes(root.value, set.header.merkleRoot)) {
        return err({ code: "UNPROVEN" });
    }
    return ok(undefined);
}
