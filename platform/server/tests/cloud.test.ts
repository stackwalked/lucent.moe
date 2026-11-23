import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { hashToken } from "../src/auth/tokens.ts";
import {
    changeItem,
    createItem,
    deleteItem,
    listHistory,
    listItems,
    readItem,
} from "../src/cloud/items.ts";
import { createShare, importShare, listShares, revokeShare } from "../src/cloud/shares.ts";
import { type Db, execute, queryOne, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { seedAccount } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const limits = { maxItems: 2, maxVersionBytes: 12, maxStoredBytes: 48, maxVersionsPerItem: 8 };
const content = { kind: "config", name: "cfg", bytes: Uint8Array.of(0, 255, 193), limits } as const;
const missing = err({ code: "NOT_FOUND" });

function value<T>(result: Result<T, unknown>) {
    invariant(result.ok, `expected success: ${JSON.stringify(result)}`);
    return result.value;
}

async function scopes(db: Db) {
    const rng = createSeededRng(7);
    const productId = ProductId.parse("sample");
    const owner = { accountId: await seedAccount(db, rng, "owner@cloud.test"), productId };
    const recipient = { accountId: await seedAccount(db, rng, "other@cloud.test"), productId };
    return {
        owner,
        recipient,
        otherProduct: { ...owner, productId: ProductId.parse("other") },
        rng,
    };
}

test("knowing an id grants neither reads nor mutations outside its account and product", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const { owner, recipient, otherProduct, rng } = await scopes(db);
        const { itemId } = value(
            await withTx(db, (tx) => createItem(tx, { ...owner, ...content })),
        );
        const share = value(await withTx(db, (tx) => createShare(tx, { ...owner, itemId }, rng)));
        for (const scope of [recipient, otherProduct]) {
            const item = { ...scope, itemId };
            expect(await listItems(db, scope)).toEqual(ok([]));
            expect(await listHistory(db, item)).toEqual(ok([]));
            expect(await listShares(db, item)).toEqual(ok([]));
            expect(await readItem(db, item, 1)).toEqual(missing);
            expect(
                await withTx(db, (tx) =>
                    changeItem(tx, {
                        ...item,
                        base: 1,
                        limits,
                        change: { type: "rename", name: "x" },
                    }),
                ),
            ).toEqual(missing);
            expect(await withTx(db, (tx) => createShare(tx, item, rng))).toEqual(missing);
            expect(await withTx(db, (tx) => revokeShare(tx, scope, share.shareId))).toEqual(
                missing,
            );
            expect(await withTx(db, (tx) => deleteItem(tx, item))).toEqual(missing);
        }
        expect(
            await withTx(db, (tx) =>
                importShare(tx, { ...otherProduct, token: share.token, limits }),
            ),
        ).toEqual(missing);
        expect(value(await readItem(db, { ...owner, itemId })).bytes).toEqual(content.bytes);
    });
});

test("simultaneous replacements retain both payloads in server order; restore appends a snapshot", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const { owner } = await scopes(db);
        const { itemId } = value(
            await withTx(db, (tx) => createItem(tx, { ...owner, ...content })),
        );
        const item = { ...owner, itemId };
        const writes = await Promise.all(
            [41, 42].map(async (n) => {
                const bytes = Uint8Array.of(n);
                const result = value(
                    await withTx(db, (tx) =>
                        changeItem(tx, {
                            ...item,
                            base: 1,
                            limits,
                            change: { type: "replace", bytes },
                        }),
                    ),
                );
                return { bytes, ...result };
            }),
        );
        expect(writes.map((w) => w.revision).sort()).toEqual([2, 3]);
        for (const write of writes) {
            expect(write.conflict).toBe(write.revision === 3);
            expect(value(await readItem(db, item, write.revision)).bytes).toEqual(write.bytes);
        }
        expect(
            value(
                await withTx(db, (tx) =>
                    changeItem(tx, {
                        ...item,
                        base: 3,
                        limits,
                        change: { type: "rename", name: "new" },
                    }),
                ),
            ).revision,
        ).toBe(4);
        expect(
            value(
                await withTx(db, (tx) =>
                    changeItem(tx, {
                        ...item,
                        base: 4,
                        limits,
                        change: { type: "restore", revision: 1 },
                    }),
                ),
            ).revision,
        ).toBe(5);
        expect(value(await readItem(db, item))).toEqual({
            itemId,
            kind: "config",
            revision: 5,
            name: content.name,
            bytes: content.bytes,
        });
        expect(value(await listHistory(db, item)).map((v) => v.revision)).toEqual([5, 4, 3, 2, 1]);
        const tampered = await execute(
            db,
            sql`update cloud_version set name = 'x' where item_id = ${itemId}`,
        );
        expect(tampered).toEqual(
            err({ code: "CHECK_VIOLATION", constraint: "cloud_version_immutable" }),
        );
    });
});

test("first writers serialize count caps and all retained names and bytes consume product storage", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const { owner, otherProduct, recipient } = await scopes(db);
        const capped = {
            ...content,
            name: "雪",
            limits: { ...limits, maxItems: 1, maxStoredBytes: 11 },
        };
        const create = () => withTx(db, (tx) => createItem(tx, { ...owner, ...capped }));
        const both = await Promise.all([create(), create()]);
        expect(both.filter((r) => !r.ok)).toEqual([err({ code: "ITEM_LIMIT" })]);
        const [item] = value(await listItems(db, owner));
        invariant(item !== undefined, "missing winning item");
        expect(
            await withTx(db, (tx) =>
                changeItem(tx, {
                    ...owner,
                    itemId: item.itemId,
                    base: 1,
                    limits: capped.limits,
                    change: { type: "restore", revision: 1 },
                }),
            ),
        ).toEqual(err({ code: "STORAGE_LIMIT" }));
        for (const scope of [otherProduct, recipient])
            value(await withTx(db, (tx) => createItem(tx, { ...scope, ...capped })));
    });
});

test("a link copies its issued snapshot; revoke or source deletion blocks imports without touching copies", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const { owner, recipient, rng } = await scopes(db);
        const { itemId } = value(
            await withTx(db, (tx) => createItem(tx, { ...owner, ...content })),
        );
        const item = { ...owner, itemId };
        const link = value(await withTx(db, (tx) => createShare(tx, item, rng)));
        expect(await listShares(db, item)).toEqual(ok([{ shareId: link.shareId, revision: 1 }]));
        const stored = value(
            await queryOne(
                db,
                z.object({ token_hash: z.instanceof(Uint8Array) }),
                sql`select token_hash from cloud_share`,
            ),
        );
        expect(stored?.token_hash).toEqual(new Uint8Array(await hashToken(link.token)));
        value(
            await withTx(db, (tx) =>
                changeItem(tx, {
                    ...item,
                    base: 1,
                    limits,
                    change: { type: "rename", name: "changed" },
                }),
            ),
        );
        const importLink = () =>
            withTx(db, (tx) => importShare(tx, { ...recipient, limits, token: link.token }));
        const copy = value(await importLink());
        expect(copy.itemId).not.toBe(itemId);
        const imported = { ...recipient, itemId: copy.itemId };
        expect(value(await readItem(db, imported))).toEqual({
            itemId: copy.itemId,
            revision: 1,
            kind: "config",
            name: "cfg",
            bytes: content.bytes,
        });
        expect(
            await withTx(db, (tx) =>
                importShare(tx, {
                    ...recipient,
                    limits: { ...limits, maxItems: 1 },
                    token: link.token,
                }),
            ),
        ).toEqual(err({ code: "ITEM_LIMIT" }));
        value(
            await withTx(db, (tx) =>
                changeItem(tx, {
                    ...imported,
                    base: 1,
                    limits,
                    change: { type: "replace", bytes: Uint8Array.of(13) },
                }),
            ),
        );
        expect(value(await readItem(db, item)).bytes).toEqual(content.bytes);
        value(await withTx(db, (tx) => revokeShare(tx, owner, link.shareId)));
        expect(await listShares(db, item)).toEqual(ok([]));
        expect(await importLink()).toEqual(missing);
        const later = value(await withTx(db, (tx) => createShare(tx, item, rng)));
        value(await withTx(db, (tx) => deleteItem(tx, item)));
        expect(
            await withTx(db, (tx) => importShare(tx, { ...recipient, limits, token: later.token })),
        ).toEqual(missing);
        expect(value(await listHistory(db, item))).toEqual([]);
        expect(value(await readItem(db, imported)).bytes).toEqual(Uint8Array.of(13));
    });
});

test("revoke cannot commit between an import's bearer check and its copy", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(
        async ({ nativeDb, browserDb }) => {
            const { owner, recipient, rng } = await scopes(nativeDb);
            const { itemId } = value(
                await withTx(nativeDb, (tx) => createItem(tx, { ...owner, ...content })),
            );
            const link = value(
                await withTx(nativeDb, (tx) => createShare(tx, { ...owner, itemId }, rng)),
            );
            const revoke = () => withTx(browserDb, (tx) => revokeShare(tx, owner, link.shareId));
            const request = { ...recipient, limits, token: link.token };
            value(
                await withTx(nativeDb, async (tx) => {
                    const copy = await importShare(tx, request);
                    if (!copy.ok) return copy;
                    expect(await revoke()).toEqual(err({ code: "STATEMENT_TIMEOUT" }));
                    return copy;
                }),
            );
            value(await revoke());
            expect(await withTx(nativeDb, (tx) => importShare(tx, request))).toEqual(missing);
        },
        { browserTimeoutMs: 150 },
    );
});
