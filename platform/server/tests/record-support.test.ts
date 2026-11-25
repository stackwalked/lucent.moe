import { expect, test } from "bun:test";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { z } from "zod";
import { type Db, queryAll, sql } from "../src/db/pool.ts";
import { readPublicStatus } from "../src/record/status.ts";
import { catalog, product } from "./authority-fixtures.ts";
import { GAME } from "./fact-set-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import { liveCatalog, supportWorld, UPDATED } from "./record-fixtures.ts";

async function changes(db: Db) {
    const rows = await queryAll(
        db,
        z.object({ product_id: z.string(), supported: z.boolean() }),
        sql`select product_id, supported from product_support_change order by id`,
    );
    invariant(rows.ok, "changes read");
    return rows.value;
}

async function status(db: Db, products: ProductCatalog) {
    const read = await readPublicStatus(db, { catalog: products });
    invariant(read.ok, "the public status reads");
    return read.value;
}

test("a game update no promoted set covers shows not yet supported once, and its promotion records the recovery", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, createSeededRng(11_001), products);
        const cs2 = async () =>
            (await status(nativeDb, products)).find((p) => p.productId === "cs2");

        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await changes(nativeDb)).toEqual([]);
        expect(await cs2()).toMatchObject({ state: "live", supported: true, recoveries: [] });

        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");
        // A second report of the same build changes nothing more.
        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");
        expect(await changes(nativeDb)).toEqual([{ product_id: "cs2", supported: false }]);
        const down = await cs2();
        expect(down?.supported).toBe(false);
        expect(down?.recoveries).toEqual([
            {
                startedAt: expect.any(Number),
                endedAt: null,
                latency: { state: "waiting", waitingMs: expect.any(Number) },
            },
        ]);

        await world.support(UPDATED);
        expect(await changes(nativeDb)).toEqual([
            { product_id: "cs2", supported: false },
            { product_id: "cs2", supported: true },
        ]);
        const up = await cs2();
        expect(up?.supported).toBe(true);
        const [recovery] = up?.recoveries ?? [];
        invariant(recovery !== undefined && recovery.endedAt !== null, "the update recovered");
        expect(recovery.latency).toEqual({
            state: "covered",
            latencyMs: recovery.endedAt - recovery.startedAt,
        });
        expect(await world.start(UPDATED)).toBe("NOT_A_REFUSAL");
        expect(await changes(nativeDb)).toHaveLength(2);
    });
});

test("a seed product's game update is recorded nowhere and is in no public status", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const products = catalog();
        expect(products.get(product("cs2").id)?.state).toBe("seed");
        const world = await supportWorld(nativeDb, createSeededRng(11_002), products);

        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");
        await world.support(UPDATED);

        expect(await changes(nativeDb)).toEqual([]);
        const listed = await status(nativeDb, products);
        expect(listed.map((p) => p.productId)).not.toContain(product("cs2").id);
        expect(JSON.stringify(listed)).not.toContain("cs2");
    });
});
