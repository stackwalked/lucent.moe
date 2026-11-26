import { err, ok, type Result } from "@lucent/core/result";
import { isCloudItemName } from "@lucent/rpc/cloud-item-guards";
import {
    CLOUD_STATUSES,
    type CloudFetched,
    type CloudListing,
    type CloudRequest,
    type CloudResponse,
    type CloudStatus,
    type CloudWritten,
    isItemName,
    MAX_NAME_BYTES,
    maxFetchResponseSize,
    maxListResponseSize,
    maxWriteRequestSize,
    toCloudResponseBytes,
} from "@lucent/wire/cloud";
import { CONTEXT_SIZE, ID_SIZE } from "@lucent/wire/codec";
import { MAX_FRAME_PLAIN_SIZE, NONCE_SIZE, TAG_SIZE } from "@lucent/wire/frame";
import { z } from "zod";
import type { DbFailure, Tx } from "../../base/db/pool.ts";
import { MAX_DATA_BODY_BYTES } from "../../edge/listeners/native/http.ts";
import type { CloudLimits } from "../cloud/items.rules.ts";
import {
    listSessionItems,
    readSessionItem,
    type SessionCaller,
    writeSessionItem,
} from "../cloud/sessions.ts";
import type { DataTooLarge } from "./data.ts";

// The cloud kinds of the data route: a running session's list, fetch, create and replace of its
// own account's items for its own product, answered as cloud_response plaintexts on the data
// route's keys and sequences. A cloud write never raises the lease's data revision: that counts
// fact deliveries, and items are fetched when the module asks.

// A frame on the wire around its plaintext: context, session, direction, sequence, nonce, tag.
const FRAME_OVERHEAD = CONTEXT_SIZE + ID_SIZE + 1 + 8 + NONCE_SIZE + TAG_SIZE;

// Items are PostgreSQL int8 identities and revisions int4; the wire carries u64 and u32.
const MAX_ITEM_ID = (1n << 63n) - 1n;
const MAX_REVISION = 2 ** 31 - 1;

// Boot refuses limits under which an accepted write wouldn't fit the data route's body limit, or
// a full fetch beside the largest list wouldn't fit one frame: nothing on this route is chunked.
export function checkCloudLimits(limits: CloudLimits): Result<void, string> {
    const write = maxWriteRequestSize(limits.maxVersionBytes) + FRAME_OVERHEAD;
    if (write > MAX_DATA_BODY_BYTES) {
        return err(`a ${write}-byte cloud write exceeds the ${MAX_DATA_BODY_BYTES}-byte data body`);
    }
    const read =
        maxFetchResponseSize(limits.maxVersionBytes) + maxListResponseSize(limits.maxItems);
    if (read > MAX_FRAME_PLAIN_SIZE) {
        return err(
            `a ${read}-byte cloud fetch and list exceed a ${MAX_FRAME_PLAIN_SIZE}-byte frame`,
        );
    }
    return ok(undefined);
}

// What a create or replace's receipt keeps, so a retry answers it again without writing twice.
export const StoredWrite = z.union([
    z.strictObject({
        status: z.literal("DONE"),
        id: z.string().regex(/^\d+$/),
        revision: z.int().positive(),
        conflict: z.boolean(),
    }),
    z.strictObject({ status: z.enum(CLOUD_STATUSES) }),
]);
export type StoredWrite = z.output<typeof StoredWrite>;

export type CloudAnswer = {
    readonly plain: Uint8Array<ArrayBuffer>;
    // A write's outcome for its receipt; null for a list or fetch, which a retry rebuilds.
    readonly stored: StoredWrite | null;
};

type InvalidRequest = { readonly code: "INVALID_REQUEST" };
type AccountSuspended = { readonly code: "ACCOUNT_SUSPENDED" };
// NOT_FOUND here is the session's own, which the data route holds locked and live: never sent.
export type CloudFailure =
    | InvalidRequest
    | AccountSuspended
    | { readonly code: "NOT_FOUND" }
    | DataTooLarge
    | DbFailure;

const DOMAIN_STATUSES: ReadonlySet<string> = new Set(
    CLOUD_STATUSES.filter((code) => code !== "UNAVAILABLE"),
);

// A refusal the cloud writers decide becomes the status byte; the rest stay the transport's.
function isDomainRefusal(error: {
    readonly code: string;
}): error is { readonly code: CloudStatus } {
    return DOMAIN_STATUSES.has(error.code);
}

// Names written before the 255-byte cap could be longer than a u8 size carries; they travel cut
// at a code point boundary, and the stored name is untouched.
function toWireName(name: string): string {
    if (isItemName(name)) return name;
    const utf8 = new TextEncoder();
    let cut = "";
    for (const point of name) {
        if (utf8.encode(cut + point).byteLength > MAX_NAME_BYTES) break;
        cut += point;
    }
    return cut;
}

function toWireId(id: bigint): string | null {
    return id >= 1n && id <= MAX_ITEM_ID ? id.toString() : null;
}

function sealable(response: CloudResponse): Result<Uint8Array<ArrayBuffer>, DataTooLarge> {
    const plain = toCloudResponseBytes(response);
    if (plain.byteLength > MAX_FRAME_PLAIN_SIZE) {
        return err({ code: "DATA_TOO_LARGE", size: plain.byteLength });
    }
    return ok(plain);
}

function writtenResponse(
    answers: bigint,
    operation: "create" | "replace",
    stored: StoredWrite,
): CloudResponse {
    if (stored.status !== "DONE") {
        return { answers, operation, result: err({ code: stored.status }) };
    }
    const written: CloudWritten = {
        id: BigInt(stored.id),
        revision: stored.revision,
        conflict: stored.conflict,
    };
    return { answers, operation, result: ok(written) };
}

async function listItems(tx: Tx, caller: SessionCaller) {
    const listed = await listSessionItems(tx, caller);
    if (!listed.ok) return listed;
    const items: CloudListing[] = listed.value
        .map((item) => ({
            id: BigInt(item.itemId),
            kind: item.kind,
            revision: item.revision,
            size: item.size,
            name: toWireName(item.name),
        }))
        .sort((left, right) => (left.id < right.id ? -1 : 1));
    return ok(items);
}

async function fetchItems(
    tx: Tx,
    caller: SessionCaller,
    wanted: Extract<CloudRequest, { readonly operation: "fetch" }>["items"],
) {
    const items: CloudFetched[] = [];
    for (const { id, revision } of wanted) {
        const itemId = toWireId(id);
        if (itemId === null || (revision !== null && revision > MAX_REVISION)) {
            items.push({ id, version: null });
            continue;
        }
        const read = await readSessionItem(tx, {
            ...caller,
            itemId,
            ...(revision === null ? {} : { revision }),
        });
        if (!read.ok && read.error.code === "NOT_FOUND") {
            items.push({ id, version: null });
            continue;
        }
        if (!read.ok) return err(read.error);
        const { kind, name, bytes, revision: at } = read.value;
        items.push({ id, version: { revision: at, kind, name: toWireName(name), body: bytes } });
    }
    return ok(items);
}

async function write(
    tx: Tx,
    params: {
        readonly caller: SessionCaller;
        readonly request: Extract<CloudRequest, { readonly operation: "create" | "replace" }>;
        readonly limits: CloudLimits;
    },
): Promise<Result<StoredWrite, InvalidRequest | AccountSuspended | DbFailure>> {
    const { caller, request, limits } = params;
    if (request.operation === "create" && !isCloudItemName(request.name)) {
        return err({ code: "INVALID_REQUEST" });
    }
    if (request.operation === "replace") {
        const itemId = toWireId(request.id);
        if (itemId === null) return ok({ status: "NOT_FOUND" });
        if (request.base > MAX_REVISION) return ok({ status: "INVALID_BASE" });
    }
    const written = await writeSessionItem(tx, {
        ...caller,
        limits,
        write:
            request.operation === "create"
                ? { type: "create", kind: request.kind, name: request.name, bytes: request.body }
                : {
                      type: "replace",
                      itemId: request.id.toString(),
                      base: request.base,
                      bytes: request.body,
                  },
    });
    if (!written.ok) {
        if (isDomainRefusal(written.error)) return ok({ status: written.error.code });
        return err(written.error);
    }
    const { itemId, revision, conflict } = written.value;
    return ok({ status: "DONE", id: itemId, revision, conflict });
}

// The response to a cloud request, built under the data route's locks once the session's standing
// is decided. A retried write answers with its stored outcome and writes nothing; a retried list
// or fetch is answered afresh. Without configured limits every operation is UNAVAILABLE.
export async function answerCloud(
    tx: Tx,
    params: {
        readonly caller: SessionCaller;
        readonly request: CloudRequest;
        readonly answers: bigint;
        readonly limits: CloudLimits | null;
        readonly replayed: StoredWrite | null;
    },
): Promise<Result<CloudAnswer, CloudFailure>> {
    const { caller, request, answers, limits } = params;
    const { operation } = request;
    if (request.operation === "create" || request.operation === "replace") {
        // A write's outcome is stored whatever it was, an unavailable one included: a retry
        // must find what it was told the first time, even if limits were configured since.
        const stored =
            params.replayed !== null
                ? ok(params.replayed)
                : limits === null
                  ? ok<StoredWrite>({ status: "UNAVAILABLE" })
                  : await write(tx, { caller, request, limits });
        if (!stored.ok) return stored;
        const plain = sealable(writtenResponse(answers, request.operation, stored.value));
        return plain.ok ? ok({ plain: plain.value, stored: stored.value }) : plain;
    }
    if (limits === null) {
        const plain = sealable({ answers, operation, result: err({ code: "UNAVAILABLE" }) });
        return plain.ok ? ok({ plain: plain.value, stored: null }) : plain;
    }
    if (request.operation === "list") {
        const items = await listItems(tx, caller);
        if (!items.ok) return items;
        const plain = sealable({ answers, operation: "list", result: ok(items.value) });
        return plain.ok ? ok({ plain: plain.value, stored: null }) : plain;
    }
    const items = await fetchItems(tx, caller, request.items);
    if (!items.ok) return items;
    const plain = sealable({ answers, operation: "fetch", result: ok(items.value) });
    return plain.ok ? ok({ plain: plain.value, stored: null }) : plain;
}
