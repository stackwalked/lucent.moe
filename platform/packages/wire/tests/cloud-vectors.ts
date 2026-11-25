import { join } from "node:path";
import { toCloudRequestBytes, toCloudResponseBytes } from "../src/cloud.ts";

// What contracts/wire/v1/cloud_* hold, made by this side's encoder: native has no generator for
// them. `bun tests/cloud-vectors.ts` writes them; cloud.test.ts checks the committed files equal
// what this makes.

export type CloudVector = { readonly bytes: Uint8Array; readonly json: unknown };

const id = (value: bigint) => value.toString(16).padStart(16, "0");
const text = (value: string) => new TextEncoder().encode(value);

const CONFIG = text('[aim]\nfov = 6.5\nbone = "head"\n');
const SCRIPT = text("-- lucent\nreturn function() end\n");
const REPLACED = text('[aim]\nfov = 4.0\nbone = "neck"\n');
// Two-, three- and four-byte UTF-8, so a decoder that counts bytes for code points fails.
const NAME = "Ranked — 日本語 \u{1f3af}";

export function cloudVectors(): Readonly<Record<string, CloudVector>> {
    const wanted = [
        { id: 0x2an, revision: null },
        { id: 0x07n, revision: 3 },
        { id: 0x8000_0000_0000_0001n, revision: null },
    ];
    const listed = [
        { id: 0x07n, kind: "script", revision: 5, size: SCRIPT.byteLength, name: "loot.lua" },
        { id: 0x2an, kind: "config", revision: 3, size: CONFIG.byteLength, name: NAME },
    ] as const;
    const fetched = [
        { id: 0x2an, version: { revision: 3, kind: "config", name: NAME, body: CONFIG } },
        { id: 0x07n, version: { revision: 3, kind: "script", name: "loot.lua", body: SCRIPT } },
        { id: 0x8000_0000_0000_0001n, version: null },
    ] as const;
    const written = { id: 0x2an, revision: 4, conflict: true };
    return {
        cloud_request_list: {
            bytes: toCloudRequestBytes({ operation: "list" }),
            json: { operation: "list" },
        },
        cloud_request_fetch: {
            bytes: toCloudRequestBytes({ operation: "fetch", items: wanted }),
            json: {
                operation: "fetch",
                items: wanted.map((item) => ({ id: id(item.id), revision: item.revision })),
            },
        },
        cloud_request_create: {
            bytes: toCloudRequestBytes({
                operation: "create",
                kind: "config",
                name: NAME,
                body: CONFIG,
            }),
            json: { operation: "create", kind: "config", name: NAME, body: CONFIG.toHex() },
        },
        cloud_request_replace: {
            bytes: toCloudRequestBytes({
                operation: "replace",
                id: 0x2an,
                base: 2,
                body: REPLACED,
            }),
            json: { operation: "replace", id: id(0x2an), base: 2, body: REPLACED.toHex() },
        },
        cloud_response_list: {
            bytes: toCloudResponseBytes({
                answers: 7n,
                operation: "list",
                result: { ok: true, value: listed },
            }),
            json: {
                answers: 7,
                operation: "list",
                status: "DONE",
                items: listed.map((item) => ({ ...item, id: id(item.id) })),
            },
        },
        cloud_response_fetch: {
            bytes: toCloudResponseBytes({
                answers: 8n,
                operation: "fetch",
                result: { ok: true, value: fetched },
            }),
            json: {
                answers: 8,
                operation: "fetch",
                status: "DONE",
                items: fetched.map((item) => ({
                    id: id(item.id),
                    version:
                        item.version === null
                            ? null
                            : { ...item.version, body: item.version.body.toHex() },
                })),
            },
        },
        cloud_response_write: {
            bytes: toCloudResponseBytes({
                answers: 9n,
                operation: "replace",
                result: { ok: true, value: written },
            }),
            json: {
                answers: 9,
                operation: "replace",
                status: "DONE",
                written: { ...written, id: id(written.id) },
            },
        },
        cloud_response_refused: {
            bytes: toCloudResponseBytes({
                answers: 10n,
                operation: "create",
                result: { ok: false, error: { code: "STORAGE_LIMIT" } },
            }),
            json: { answers: 10, operation: "create", status: "STORAGE_LIMIT" },
        },
    };
}

export function toVectorJson(json: unknown): string {
    return `${JSON.stringify(json, null, 2)}\n`;
}

if (import.meta.main) {
    const out = join(import.meta.dir, "..", "..", "..", "..", "contracts", "wire", "v1");
    for (const [name, vector] of Object.entries(cloudVectors())) {
        await Bun.write(join(out, `${name}.bin`), vector.bytes);
        await Bun.write(join(out, `${name}.json`), toVectorJson(vector.json));
    }
}
