import { expect, test } from "bun:test";
import { ProductId } from "@lucent/core/scalars";
import { CloudId } from "@lucent/rpc/cloud-item";
import { z } from "zod";
import { cloudSearch, inboxSearch, listSearch } from "../src/search.ts";

// The routes' search readers stand in for the zod schemas they replaced: a reader that takes
// what the schema refused, or refuses what it took, changes which addresses open a page.

const SCHEMAS = [
    [listSearch, z.object({ q: z.string().max(200).optional() })],
    [inboxSearch, z.object({ cursor: z.uuid().optional() })],
    [
        cloudSearch,
        z.object({
            product: ProductId.optional(),
            item: CloudId.optional(),
            kind: z.enum(["config", "inventory", "script"]).optional(),
            find: z.string().max(64).optional(),
        }),
    ],
] as const;

const UUID = "123e4567-e89b-12d3-a456-426614174000";

const CANDIDATES: readonly unknown[] = [
    {},
    { q: "status:suspended ali" },
    { q: "" },
    { q: "a".repeat(200) },
    { q: "a".repeat(201) },
    { q: 5 },
    { q: null },
    { q: undefined },
    { q: ["a"] },
    { q: "x", page: 2 },
    { cursor: UUID },
    { cursor: "not-a-uuid" },
    { kind: "script" },
    { kind: "models" },
    { find: "overlay" },
    { find: "a".repeat(65) },
    { cursor: 1 },
    { cursor: UUID, q: "x" },
    { product: "cs2" },
    { product: "CS2" },
    { product: 2 },
    { item: "42" },
    { item: "042" },
    { item: 42 },
    { item: "9223372036854775808" },
    { product: "cs2", item: "42" },
    { product: "cs2", item: "x" },
    [],
    null,
    "q=x",
];

test("each search reader takes and returns what its zod schema did", () => {
    for (const [reader, schema] of SCHEMAS) {
        for (const candidate of CANDIDATES) {
            const read = reader["~standard"].validate(candidate);
            const parsed = schema.safeParse(candidate);
            expect([candidate, "value" in read ? read.value : null]).toEqual([
                candidate,
                parsed.success ? parsed.data : null,
            ]);
        }
    }
});

test("a reader leaves out a key that was not given", () => {
    const read = cloudSearch["~standard"].validate({ product: "cs2", item: undefined });
    expect("value" in read && Object.keys(read.value)).toEqual(["product"]);
});
