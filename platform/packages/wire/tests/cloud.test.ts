import { expect, test } from "bun:test";
import { createWriter } from "@lucent/bundle/wire";
import { z } from "zod";
import {
    CLOUD_KINDS,
    CLOUD_STATUSES,
    isItemName,
    parseCloudRequest,
    parseCloudResponse,
    toCloudRequestBytes,
    toCloudResponseBytes,
} from "../src/cloud.ts";
import { bigintNumber, hexAny, hexU64, readContractFile, readContractJson } from "./fixtures.ts";

// contracts/wire/v1/cloud_*, produced by src/cloud.ts's encoder; native/libs/wire must match them.
// The refusals below build or patch bytes at offsets written out here, so they state the layout
// independently of the encoder.

const MALFORMED = { ok: false, error: { code: "MALFORMED" } } as const;

async function vector<T extends z.ZodType>(name: string, schema: T) {
    return {
        bytes: new Uint8Array(await readContractFile("wire", `${name}.bin`)),
        stated: schema.parse(await readContractJson("wire", `${name}.json`)),
    };
}

const Kind = z.enum(CLOUD_KINDS);

const RequestVector = z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("list") }),
    z.strictObject({
        operation: z.literal("fetch"),
        items: z.array(
            z.strictObject({ id: hexU64, revision: z.number().int().positive().nullable() }),
        ),
    }),
    z.strictObject({
        operation: z.literal("create"),
        kind: Kind,
        name: z.string(),
        body: hexAny,
    }),
    z.strictObject({
        operation: z.literal("replace"),
        id: hexU64,
        base: z.number().int().positive(),
        body: hexAny,
    }),
]);

const Head = { answers: bigintNumber };
const ResponseVector = z.union([
    z
        .strictObject({
            ...Head,
            operation: z.enum(["list", "fetch", "create", "replace"]),
            status: z.enum(CLOUD_STATUSES),
        })
        .transform(({ answers, operation, status }) => ({
            answers,
            operation,
            result: { ok: false as const, error: { code: status } },
        })),
    z
        .strictObject({
            ...Head,
            operation: z.literal("list"),
            status: z.literal("DONE"),
            items: z.array(
                z.strictObject({
                    id: hexU64,
                    kind: Kind,
                    revision: z.number().int(),
                    size: z.number().int(),
                    name: z.string(),
                }),
            ),
        })
        .transform(({ answers, operation, items }) => ({
            answers,
            operation,
            result: { ok: true as const, value: items },
        })),
    z
        .strictObject({
            ...Head,
            operation: z.literal("fetch"),
            status: z.literal("DONE"),
            items: z.array(
                z.strictObject({
                    id: hexU64,
                    version: z
                        .strictObject({
                            revision: z.number().int(),
                            kind: Kind,
                            name: z.string(),
                            body: hexAny,
                        })
                        .nullable(),
                }),
            ),
        })
        .transform(({ answers, operation, items }) => ({
            answers,
            operation,
            result: { ok: true as const, value: items },
        })),
    z
        .strictObject({
            ...Head,
            operation: z.enum(["create", "replace"]),
            status: z.literal("DONE"),
            written: z.strictObject({
                id: hexU64,
                revision: z.number().int(),
                conflict: z.boolean(),
            }),
        })
        .transform(({ answers, operation, written }) => ({
            answers,
            operation,
            result: { ok: true as const, value: written },
        })),
]);

const REQUESTS = ["list", "fetch", "create", "replace"].map((name) => `cloud_request_${name}`);
const RESPONSES = ["list", "fetch", "write", "refused"].map((name) => `cloud_response_${name}`);

test("the cloud request vectors decode to what they state, and encode back to their bytes", async () => {
    for (const name of REQUESTS) {
        const { bytes, stated } = await vector(name, RequestVector);

        expect(parseCloudRequest(bytes)).toEqual({ ok: true, value: stated });
        expect(toCloudRequestBytes(stated)).toEqual(bytes);
    }
});

test("the cloud response vectors decode to what they state, and encode back to their bytes", async () => {
    for (const name of RESPONSES) {
        const { bytes, stated } = await vector(name, ResponseVector);

        expect(parseCloudResponse(bytes)).toEqual({ ok: true, value: stated });
        expect(toCloudResponseBytes(stated)).toEqual(bytes);
    }
});

async function bytesOf(name: string): Promise<Uint8Array> {
    return new Uint8Array(await readContractFile("wire", `${name}.bin`));
}

function withByte(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const out = bytes.slice();
    out[offset] = value;
    return out;
}

function withBytes(bytes: Uint8Array, offset: number, value: Uint8Array): Uint8Array {
    const out = bytes.slice();
    out.set(value, offset);
    return out;
}

function context(text: string): Uint8Array {
    const out = new Uint8Array(32);
    out.set(new TextEncoder().encode(text));
    return out;
}

// Request bytes by hand: the context, the operation, then `fill` writes the rest.
function request(operation: number, fill: (out: ReturnType<typeof createWriter>) => void) {
    const out = createWriter();
    out.bytes(context("lucent cloud request v1"));
    out.u8(operation);
    fill(out);
    return out.finish();
}

function createWithName(name: Uint8Array, kind = 1) {
    return request(3, (out) => {
        out.u8(kind);
        out.u8(name.byteLength);
        out.bytes(name);
        out.u32(2);
        out.bytes(new Uint8Array([1, 2]));
    });
}

function fetchOf(ids: readonly bigint[]): Uint8Array {
    return request(2, (out) => {
        out.u8(ids.length);
        for (const id of ids) {
            out.u64(id);
            out.u32(0);
        }
    });
}

const ascii = (text: string) => new TextEncoder().encode(text);

test("no prefix or extension of a self-delimiting cloud vector decodes", async () => {
    const delimited = [
        ...REQUESTS.map((name) => [name, parseCloudRequest] as const),
        ...["cloud_response_list", "cloud_response_write", "cloud_response_refused"].map(
            (name) => [name, parseCloudResponse] as const,
        ),
    ];
    for (const [name, parse] of delimited) {
        const bytes = await bytesOf(name);
        const extended = new Uint8Array(bytes.byteLength + 1);
        extended.set(bytes);

        expect(parse(bytes).ok).toBe(true);
        for (let size = 0; size < bytes.byteLength; size += 1) {
            expect(parse(bytes.subarray(0, size))).toEqual(MALFORMED);
        }
        expect(parse(extended)).toEqual(MALFORMED);
    }
});

test("a fetch answer ends with its last entry: a cut inside one or a byte past it is malformed", async () => {
    const bytes = await bytesOf("cloud_response_fetch");
    const extended = new Uint8Array(bytes.byteLength + 1);
    extended.set(bytes);
    // The last entry is the unfound id: 8 bytes of id and its found flag.
    const lastEntry = bytes.byteLength - 9;

    expect(parseCloudResponse(extended)).toEqual(MALFORMED);
    for (let size = lastEntry + 1; size < bytes.byteLength; size += 1) {
        expect(parseCloudResponse(bytes.subarray(0, size))).toEqual(MALFORMED);
    }
    expect(parseCloudResponse(bytes.subarray(0, lastEntry)).ok).toBe(true);
    // Nothing after the status: a done fetch answers at least one item.
    expect(parseCloudResponse(bytes.subarray(0, 42))).toEqual(MALFORMED);
});

test("a cloud message under another kind's context is malformed, its own at v2 a version mismatch", async () => {
    const list = await bytesOf("cloud_request_list");
    const write = await bytesOf("cloud_response_write");
    const mismatch = { ok: false, error: { code: "VERSION_MISMATCH" } } as const;

    expect(parseCloudResponse(list)).toEqual(MALFORMED);
    expect(parseCloudRequest(write)).toEqual(MALFORMED);
    expect(parseCloudRequest(withByte(list, 22, "2".charCodeAt(0)))).toEqual(mismatch);
    expect(parseCloudResponse(withByte(write, 23, "2".charCodeAt(0)))).toEqual(mismatch);
    expect(parseCloudRequest(withBytes(list, 0, context("lucent data request v1")))).toEqual(
        MALFORMED,
    );
});

test("a cloud request with an unknown operation, kind or a zero base is malformed", async () => {
    const list = await bytesOf("cloud_request_list");
    const create = await bytesOf("cloud_request_create");
    const replace = await bytesOf("cloud_request_replace");

    expect(parseCloudRequest(withByte(list, 32, 0))).toEqual(MALFORMED);
    expect(parseCloudRequest(withByte(list, 32, 5))).toEqual(MALFORMED);
    for (const kind of [0, 4, 0xff]) {
        expect(parseCloudRequest(withByte(create, 33, kind))).toEqual(MALFORMED);
    }
    for (const kind of [1, 2, 3]) {
        expect(parseCloudRequest(withByte(create, 33, kind)).ok).toBe(true);
    }
    expect(parseCloudRequest(withBytes(replace, 41, new Uint8Array(4)))).toEqual(MALFORMED);
});

test("a fetch asks for 1 to 16 items with unique ids", () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => BigInt(index + 1));

    expect(parseCloudRequest(fetchOf([]))).toEqual(MALFORMED);
    expect(parseCloudRequest(fetchOf(ids(1))).ok).toBe(true);
    expect(parseCloudRequest(fetchOf(ids(16))).ok).toBe(true);
    expect(parseCloudRequest(fetchOf(ids(17)))).toEqual(MALFORMED);
    expect(parseCloudRequest(fetchOf([5n, 9n, 5n]))).toEqual(MALFORMED);
    // Request order is the answer's order, so it needn't ascend.
    expect(parseCloudRequest(fetchOf([9n, 5n, 1n]))).toEqual({
        ok: true,
        value: {
            operation: "fetch",
            items: [9n, 5n, 1n].map((id) => ({ id, revision: null })),
        },
    });
});

test("a body size that isn't the bytes left is malformed", async () => {
    const replace = await bytesOf("cloud_request_replace");
    const create = await bytesOf("cloud_request_create");
    const size = new DataView(replace.buffer).getUint32(45, true);
    const u32 = (value: number) => {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, value, true);
        return out;
    };
    // create: context, operation, kind, name size, the name, then the body's size.
    const createSizeAt = 35 + (create[34] ?? 0);

    expect(size).toBe(replace.byteLength - 49);
    for (const wrong of [size - 1, size + 1, 0xffff_ffff]) {
        expect(parseCloudRequest(withBytes(replace, 45, u32(wrong)))).toEqual(MALFORMED);
    }
    expect(parseCloudRequest(withBytes(create, createSizeAt, u32(0)))).toEqual(MALFORMED);
});

test("a name is 1 to 255 bytes of well-formed UTF-8, no NUL, at most 64 code points", () => {
    const table: readonly [string, Uint8Array<ArrayBuffer>, boolean][] = [
        ["one ASCII byte", ascii("a"), true],
        ["64 code points", ascii("x".repeat(64)), true],
        ["63 four-byte code points (252 bytes)", ascii("\u{1f3af}".repeat(63)), true],
        ["a kept byte order mark", new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), true],
        ["empty", new Uint8Array(), false],
        ["65 code points", ascii("x".repeat(65)), false],
        ["a NUL", ascii("a\0b"), false],
        ["a stray continuation byte", new Uint8Array([0x61, 0x80]), false],
        ["0xff", new Uint8Array([0xff]), false],
        ["an overlong slash", new Uint8Array([0xc0, 0xaf]), false],
        ["an encoded surrogate", new Uint8Array([0xed, 0xa0, 0x80]), false],
        ["a cut sequence", new Uint8Array([0xe6, 0x97]), false],
    ];
    for (const [label, name, valid] of table) {
        const parsed = parseCloudRequest(createWithName(name));

        expect({ label, ok: parsed.ok }).toEqual({ label, ok: valid });
        if (parsed.ok) {
            expect(toCloudRequestBytes(parsed.value)).toEqual(createWithName(name));
        }
    }
});

test("isItemName agrees with the wire on strings this side builds", () => {
    expect(isItemName("Ranked — 日本語")).toBe(true);
    expect(isItemName("﻿a")).toBe(true);
    expect(isItemName("")).toBe(false);
    expect(isItemName("a\0")).toBe(false);
    expect(isItemName("\ud800")).toBe(false);
    expect(isItemName("x".repeat(65))).toBe(false);
    // 64 code points that need 256 bytes: within the count, over the size.
    expect(isItemName("\u{1f3af}".repeat(64))).toBe(false);
});

test("a cloud response with an unknown operation or status, or bytes after a refusal, is malformed", async () => {
    const refused = await bytesOf("cloud_response_refused");

    expect(parseCloudResponse(withByte(refused, 40, 0))).toEqual(MALFORMED);
    expect(parseCloudResponse(withByte(refused, 40, 5))).toEqual(MALFORMED);
    expect(parseCloudResponse(withByte(refused, 41, CLOUD_STATUSES.length + 1))).toEqual(MALFORMED);
    CLOUD_STATUSES.forEach((code, index) => {
        expect(parseCloudResponse(withByte(refused, 41, index + 1))).toEqual({
            ok: true,
            value: { answers: 10n, operation: "create", result: { ok: false, error: { code } } },
        });
    });
});

test("a write answer's revision is 1 or more and its conflict flag 0 or 1", async () => {
    const write = await bytesOf("cloud_response_write");

    expect(parseCloudResponse(withBytes(write, 50, new Uint8Array(4)))).toEqual(MALFORMED);
    expect(parseCloudResponse(withByte(write, 54, 2))).toEqual(MALFORMED);
    expect(parseCloudResponse(withByte(write, 54, 0)).ok).toBe(true);
});

test("a list answer's ids ascend, with known kinds and revisions of 1 or more", async () => {
    const list = await bytesOf("cloud_response_list");
    // The first entry: u64 id at 44, kind at 52, revision at 53, size at 57, name size at 61.
    const secondAt = 62 + (list[61] ?? 0);
    const secondId = list.slice(secondAt, secondAt + 8);

    expect(parseCloudResponse(withBytes(list, 44, secondId))).toEqual(MALFORMED);
    expect(parseCloudResponse(withBytes(list, 44, new Uint8Array(8).fill(0xff)))).toEqual(
        MALFORMED,
    );
    expect(parseCloudResponse(withByte(list, 52, 0))).toEqual(MALFORMED);
    expect(parseCloudResponse(withByte(list, 52, 4))).toEqual(MALFORMED);
    expect(parseCloudResponse(withBytes(list, 53, new Uint8Array(4)))).toEqual(MALFORMED);
    // A count of 3 over two entries.
    expect(parseCloudResponse(withByte(list, 42, 3))).toEqual(MALFORMED);
});

test("a fetch answer's entries have unique ids, found flags of 0 or 1, and at most 16 entries", async () => {
    const fetch = await bytesOf("cloud_response_fetch");
    // Entries from 42: u64 id, found at 50, then revision at 51 and kind at 55.
    const unfound = fetch.slice(fetch.byteLength - 9);
    const head = fetch.slice(0, 42);
    const entries = (count: number) => {
        const out = new Uint8Array(42 + count * 9);
        out.set(head);
        for (let index = 0; index < count; index += 1) {
            const entry = unfound.slice();
            entry[0] = index + 1;
            out.set(entry, 42 + index * 9);
        }
        return out;
    };

    expect(parseCloudResponse(withByte(fetch, 50, 2))).toEqual(MALFORMED);
    expect(parseCloudResponse(withBytes(fetch, 51, new Uint8Array(4)))).toEqual(MALFORMED);
    expect(parseCloudResponse(withByte(fetch, 55, 4))).toEqual(MALFORMED);
    expect(parseCloudResponse(withBytes(fetch, fetch.byteLength - 9, fetch.slice(42, 50)))).toEqual(
        MALFORMED,
    );
    expect(parseCloudResponse(entries(16)).ok).toBe(true);
    expect(parseCloudResponse(entries(17))).toEqual(MALFORMED);
});
