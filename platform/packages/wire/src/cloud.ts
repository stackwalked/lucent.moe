import {
    createWriter,
    type FormatError,
    malformed,
    openReader,
    type Reader,
    type Writer,
} from "@lucent/bundle/wire";
import { invariant, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { finish, readContext, readFlag, writeContext } from "./codec.ts";
import { MAX_FRAME_PLAIN_SIZE } from "./frame.ts";

// The cloud kinds of the data route (POST /v1/sessions/:id/data): a module lists, fetches, creates
// and replaces its account's items for its product. Each is the plaintext of a data-route frame,
// beside data_request and data_response on the same keys and sequences; the server tells them
// apart by the context.
//
// On the wire, both version 1:
//   request: context "lucent cloud request v1" (32), u8 operation, then by operation:
//     1 list: nothing.
//     2 fetch: u8 item count (1 to 16), then per item: u64 item id, u32 revision (0 for the head);
//       ids unique, in the order the answer keeps.
//     3 create: u8 kind (1 config, 2 inventory, 3 script), u8 name size (1 to 255), the name
//       (UTF-8, well formed, no NUL, at most 64 code points), u32 body size, the body.
//     4 replace: u64 item id, u32 base revision (1 or more), u32 body size, the body.
//   response: context "lucent cloud response v1" (32), u64 the sequence it answers, u8 the
//     operation it answers, u8 status (0 done, else a code below), then after 0 only, by operation:
//     1 list: u16 item count, then per item, by ascending id: u64 item id, u8 kind, u32 revision,
//       u32 body size, u8 name size, the name.
//     2 fetch: per asked item, in request order: u64 item id, u8 found (0 or 1), after 1 only:
//       u32 revision, u8 kind, u8 name size, the name, u32 body size, the body.
//     3 create, 4 replace: u64 item id, u32 revision, u8 conflict (0 or 1).
//   status: 1 NOT_FOUND, 2 INVALID_BASE, 3 ITEM_LIMIT, 4 SIZE_LIMIT, 5 STORAGE_LIMIT,
//     6 VERSION_LIMIT, 7 UNAVAILABLE (limits not configured).
//
// Provenance: approved by the human on 2026-11-24 as the packet 07 proposal. The golden vectors
// contracts/wire/v1/cloud_* were produced by this encoder, not by native/libs/wire; native's
// encoder and decoder must match them byte for byte.
//
// Beyond the layout, this side reads a revision the server states (listed, fetched, written) as 1
// or more, since revision 0 names no version; a status above 7 is MALFORMED, as a new code would
// come with a new version.

const VERSION = 1;

export const MAX_FETCH_ITEMS = 16;
export const MAX_NAME_BYTES = 255;
export const MAX_NAME_CODE_POINTS = 64;

const OPERATIONS = ["list", "fetch", "create", "replace"] as const;
export type CloudOperation = (typeof OPERATIONS)[number];

export const CLOUD_KINDS = ["config", "inventory", "script"] as const;
export type CloudKind = (typeof CLOUD_KINDS)[number];

// In wire order from 1.
export const CLOUD_STATUSES = [
    "NOT_FOUND",
    "INVALID_BASE",
    "ITEM_LIMIT",
    "SIZE_LIMIT",
    "STORAGE_LIMIT",
    "VERSION_LIMIT",
    "UNAVAILABLE",
] as const;
export type CloudStatus = (typeof CLOUD_STATUSES)[number];
export type CloudRefusal = { readonly code: CloudStatus };

// One item a fetch asks for: the version at `revision`, or the head when it is null.
export type CloudWanted = { readonly id: bigint; readonly revision: number | null };

export type CloudRequest =
    | { readonly operation: "list" }
    | { readonly operation: "fetch"; readonly items: readonly CloudWanted[] }
    | {
          readonly operation: "create";
          readonly kind: CloudKind;
          readonly name: string;
          readonly body: Uint8Array;
      }
    | {
          readonly operation: "replace";
          readonly id: bigint;
          // The revision the module's copy was read at.
          readonly base: number;
          readonly body: Uint8Array;
      };

// An item's head as a list states it: its body's size, not the body.
export type CloudListing = {
    readonly id: bigint;
    readonly kind: CloudKind;
    readonly revision: number;
    readonly size: number;
    readonly name: string;
};

export type CloudVersion = {
    readonly revision: number;
    readonly kind: CloudKind;
    readonly name: string;
    readonly body: Uint8Array;
};

// One asked item: its version, or null when the account's product holds no such item or revision.
export type CloudFetched = { readonly id: bigint; readonly version: CloudVersion | null };

export type CloudWritten = {
    readonly id: bigint;
    readonly revision: number;
    // The base was no longer the head; the displaced head stays in history.
    readonly conflict: boolean;
};

export type CloudResponse = {
    // The sequence of the module's data-route frame this answers.
    readonly answers: bigint;
} & (
    | {
          readonly operation: "list";
          readonly result: Result<readonly CloudListing[], CloudRefusal>;
      }
    | {
          readonly operation: "fetch";
          readonly result: Result<readonly CloudFetched[], CloudRefusal>;
      }
    | {
          readonly operation: "create" | "replace";
          readonly result: Result<CloudWritten, CloudRefusal>;
      }
);

const utf8 = new TextEncoder();
// Fatal, so ill-formed bytes (overlong forms, surrogates) never decode; ignoreBOM, so a leading
// U+FEFF stays in the name and re-encodes to the same bytes.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function isItemName(name: string): boolean {
    if (!name.isWellFormed() || name.includes("\0")) {
        return false;
    }
    const size = utf8.encode(name).byteLength;
    return size >= 1 && size <= MAX_NAME_BYTES && [...name].length <= MAX_NAME_CODE_POINTS;
}

function isRevision(revision: number): boolean {
    return Number.isInteger(revision) && revision >= 1 && revision <= 0xffff_ffff;
}

function writeName(out: Writer, name: string): void {
    invariant(isItemName(name), "item name isn't valid");
    const bytes = utf8.encode(name);
    out.u8(bytes.byteLength);
    out.bytes(bytes);
}

function readName(input: Reader): Result<string, FormatError> {
    if (input.remaining() < 1) {
        return malformed();
    }
    const size = input.u8();
    if (size === 0 || input.remaining() < size) {
        return malformed();
    }
    const bytes = input.bytes(size);
    const name = trySync(
        () => strictUtf8.decode(bytes),
        () => null,
    );
    return name.ok && isItemName(name.value) ? ok(name.value) : malformed();
}

function writeKind(out: Writer, kind: CloudKind): void {
    out.u8(CLOUD_KINDS.indexOf(kind) + 1);
}

// The caller has checked one byte remains.
function readKind(input: Reader): CloudKind | null {
    return CLOUD_KINDS[input.u8() - 1] ?? null;
}

function writeBody(out: Writer, body: Uint8Array): void {
    out.u32(body.byteLength);
    out.bytes(body);
}

function readBody(input: Reader): Result<Uint8Array<ArrayBuffer>, FormatError> {
    if (input.remaining() < 4) {
        return malformed();
    }
    const size = input.u32();
    if (size > MAX_FRAME_PLAIN_SIZE || input.remaining() < size) {
        return malformed();
    }
    return ok(input.bytes(size));
}

function hasUniqueIds(items: readonly { readonly id: bigint }[]): boolean {
    return new Set(items.map((item) => item.id)).size === items.length;
}

function finished(out: Writer): Uint8Array<ArrayBuffer> {
    const bytes = out.finish();
    invariant(bytes.byteLength <= MAX_FRAME_PLAIN_SIZE, "cloud message too large for a frame");
    return bytes;
}

export function toCloudRequestBytes(request: CloudRequest): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeContext(out, "cloud request", VERSION);
    out.u8(OPERATIONS.indexOf(request.operation) + 1);
    switch (request.operation) {
        case "list":
            break;
        case "fetch":
            invariant(
                request.items.length >= 1 && request.items.length <= MAX_FETCH_ITEMS,
                "fetch item count out of range",
            );
            invariant(hasUniqueIds(request.items), "fetch item ids aren't unique");
            out.u8(request.items.length);
            for (const item of request.items) {
                invariant(item.revision === null || isRevision(item.revision), "revision");
                out.u64(item.id);
                out.u32(item.revision ?? 0);
            }
            break;
        case "create":
            writeKind(out, request.kind);
            writeName(out, request.name);
            writeBody(out, request.body);
            break;
        case "replace":
            invariant(isRevision(request.base), "base revision out of range");
            out.u64(request.id);
            out.u32(request.base);
            writeBody(out, request.body);
            break;
    }
    return finished(out);
}

// Canonical or nothing: a known operation, 1 to 16 unique fetched ids, a known kind, a name as
// isItemName states it, a base of 1 or more, a body size that matches, nothing trailing.
export function parseCloudRequest(bytes: Uint8Array): Result<CloudRequest, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "cloud request", VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 1) {
        return malformed();
    }
    switch (OPERATIONS[input.u8() - 1]) {
        case "list":
            return finish(input, { operation: "list" });
        case "fetch":
            return parseFetchRequest(input);
        case "create": {
            if (input.remaining() < 1) {
                return malformed();
            }
            const kind = readKind(input);
            if (kind === null) {
                return malformed();
            }
            const name = readName(input);
            if (!name.ok) {
                return name;
            }
            const body = readBody(input);
            if (!body.ok) {
                return body;
            }
            return finish(input, { operation: "create", kind, name: name.value, body: body.value });
        }
        case "replace": {
            if (input.remaining() < 8 + 4) {
                return malformed();
            }
            const id = input.u64();
            const base = input.u32();
            if (base === 0) {
                return malformed();
            }
            const body = readBody(input);
            if (!body.ok) {
                return body;
            }
            return finish(input, { operation: "replace", id, base, body: body.value });
        }
        default:
            return malformed();
    }
}

function parseFetchRequest(input: Reader): Result<CloudRequest, FormatError> {
    if (input.remaining() < 1) {
        return malformed();
    }
    const count = input.u8();
    if (count < 1 || count > MAX_FETCH_ITEMS || input.remaining() < count * (8 + 4)) {
        return malformed();
    }
    const items: CloudWanted[] = [];
    for (let index = 0; index < count; index += 1) {
        const id = input.u64();
        const revision = input.u32();
        items.push({ id, revision: revision === 0 ? null : revision });
    }
    if (!hasUniqueIds(items)) {
        return malformed();
    }
    return finish(input, { operation: "fetch", items });
}

export function toCloudResponseBytes(response: CloudResponse): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeContext(out, "cloud response", VERSION);
    out.u64(response.answers);
    out.u8(OPERATIONS.indexOf(response.operation) + 1);
    if (!response.result.ok) {
        out.u8(CLOUD_STATUSES.indexOf(response.result.error.code) + 1);
        return finished(out);
    }
    out.u8(0);
    switch (response.operation) {
        case "list":
            writeListing(out, response.result.value);
            break;
        case "fetch":
            writeFetched(out, response.result.value);
            break;
        case "create":
        case "replace":
            writeWritten(out, response.result.value);
            break;
    }
    return finished(out);
}

function writeListing(out: Writer, items: readonly CloudListing[]): void {
    invariant(items.length <= 0xffff, "too many listed items");
    invariant(
        items.every((item, index) => index === 0 || (items[index - 1]?.id ?? 0n) < item.id),
        "listed ids aren't ascending",
    );
    out.u16(items.length);
    for (const item of items) {
        invariant(isRevision(item.revision), "listed revision out of range");
        out.u64(item.id);
        writeKind(out, item.kind);
        out.u32(item.revision);
        out.u32(item.size);
        writeName(out, item.name);
    }
}

function writeFetched(out: Writer, items: readonly CloudFetched[]): void {
    invariant(items.length >= 1 && items.length <= MAX_FETCH_ITEMS, "fetched count out of range");
    invariant(hasUniqueIds(items), "fetched ids aren't unique");
    for (const item of items) {
        out.u64(item.id);
        out.u8(item.version === null ? 0 : 1);
        if (item.version === null) {
            continue;
        }
        invariant(isRevision(item.version.revision), "fetched revision out of range");
        out.u32(item.version.revision);
        writeKind(out, item.version.kind);
        writeName(out, item.version.name);
        writeBody(out, item.version.body);
    }
}

function writeWritten(out: Writer, written: CloudWritten): void {
    invariant(isRevision(written.revision), "written revision out of range");
    out.u64(written.id);
    out.u32(written.revision);
    out.u8(written.conflict ? 1 : 0);
}

// Canonical or nothing: a known operation and status, nothing after a refusal, listed ids
// ascending, 1 to 16 unique fetched ids, flags of 0 or 1, revisions of 1 or more, known kinds,
// names as isItemName states them, nothing trailing. A fetch answer has no count of its own: its
// entries run to the end of the plaintext, and pairing them with the request is the module's.
export function parseCloudResponse(bytes: Uint8Array): Result<CloudResponse, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "cloud response", VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 8 + 1 + 1) {
        return malformed();
    }
    const answers = input.u64();
    const operation = OPERATIONS[input.u8() - 1];
    const status = input.u8();
    if (operation === undefined) {
        return malformed();
    }
    if (status !== 0) {
        const code = CLOUD_STATUSES[status - 1];
        if (code === undefined) {
            return malformed();
        }
        return finish(input, { answers, operation, result: err({ code }) });
    }
    if (operation === "list") {
        const items = readListing(input);
        if (!items.ok) {
            return items;
        }
        return finish(input, { answers, operation, result: ok(items.value) });
    }
    if (operation === "fetch") {
        const items = readFetched(input);
        if (!items.ok) {
            return items;
        }
        return finish(input, { answers, operation, result: ok(items.value) });
    }
    const written = readWritten(input);
    if (!written.ok) {
        return written;
    }
    return finish(input, { answers, operation, result: ok(written.value) });
}

function readListing(input: Reader): Result<readonly CloudListing[], FormatError> {
    if (input.remaining() < 2) {
        return malformed();
    }
    const count = input.u16();
    const items: CloudListing[] = [];
    for (let index = 0; index < count; index += 1) {
        if (input.remaining() < 8 + 1 + 4 + 4) {
            return malformed();
        }
        const id = input.u64();
        const kind = readKind(input);
        const revision = input.u32();
        const size = input.u32();
        const previous = items.at(-1);
        if (kind === null || revision === 0 || (previous !== undefined && previous.id >= id)) {
            return malformed();
        }
        const name = readName(input);
        if (!name.ok) {
            return name;
        }
        items.push({ id, kind, revision, size, name: name.value });
    }
    return ok(items);
}

function readFetched(input: Reader): Result<readonly CloudFetched[], FormatError> {
    const items: CloudFetched[] = [];
    while (input.remaining() > 0) {
        if (items.length === MAX_FETCH_ITEMS || input.remaining() < 8 + 1) {
            return malformed();
        }
        const id = input.u64();
        const found = readFlag(input);
        if (found === null) {
            return malformed();
        }
        if (!found) {
            items.push({ id, version: null });
            continue;
        }
        if (input.remaining() < 4 + 1) {
            return malformed();
        }
        const revision = input.u32();
        const kind = readKind(input);
        if (revision === 0 || kind === null) {
            return malformed();
        }
        const name = readName(input);
        if (!name.ok) {
            return name;
        }
        const body = readBody(input);
        if (!body.ok) {
            return body;
        }
        items.push({ id, version: { revision, kind, name: name.value, body: body.value } });
    }
    if (items.length === 0 || !hasUniqueIds(items)) {
        return malformed();
    }
    return ok(items);
}

function readWritten(input: Reader): Result<CloudWritten, FormatError> {
    if (input.remaining() < 8 + 4 + 1) {
        return malformed();
    }
    const id = input.u64();
    const revision = input.u32();
    const conflict = readFlag(input);
    if (revision === 0 || conflict === null) {
        return malformed();
    }
    return ok({ id, revision, conflict });
}
