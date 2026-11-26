import { expect, test } from "bun:test";
import type { ModuleKey } from "@lucent/bundle/fact-set";
import { toReleaseManifestV3Bytes } from "@lucent/bundle/release-manifest";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { ChannelId, ProductId } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/db/pool.ts";
import { promoteFactSet } from "../src/facts/promotion.ts";
import { readPublicStatus } from "../src/record/status.ts";
import { promoteRelease } from "../src/releases/promotion.ts";
import { catalog, product, scalar } from "./authority-fixtures.ts";
import { CAPABILITIES, FACTS, GAME, publishWith } from "./fact-set-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import { FEATURES } from "./native-fixtures.ts";
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
    return read.value.products;
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

// A cs2 release on alpha staged as ops leaves one, with the same manifest: not yet current.
async function stageRelease(db: Db, rng: SeededRng): Promise<{ id: Uint8Array; number: string }> {
    const id = rng.fillBytes(new Uint8Array(16));
    const manifest = toReleaseManifestV3Bytes({
        product: "cs2",
        facts: FACTS,
        capabilities: CAPABILITIES,
        features: [...FEATURES],
    });
    const stored = await execute(
        db,
        sql`insert into release (id, product_id, channel, container, manifest, data_response)
            values (${id}, 'cs2', 'alpha', ${rng.fillBytes(new Uint8Array(100))}, ${manifest}, 2)`,
    );
    invariant(stored.ok, "the release is stored");
    const number = await scalar(
        db,
        z.string(),
        sql`insert into release_seal (product_id, channel, number, release_id, seal)
            select 'cs2', 'alpha', coalesce(max(number), 0) + 1, ${id},
                   ${rng.fillBytes(new Uint8Array(96))}
            from release_seal where product_id = 'cs2' and channel = 'alpha'
            returning number::text as value`,
    );
    return { id, number };
}

async function promoteSet(
    db: Db,
    caller: Caller,
    release: Uint8Array,
    build: ModuleKey,
    revision: number,
) {
    const published = await publishWith(db, release, {
        keys: [0x10n, 0x20n],
        revision,
        modules: [build],
    });
    invariant(published.ok, "the set is published");
    const setId = await scalar(
        db,
        z.string(),
        sql`select distinct set_id::text as value from fact_set_build where revision = ${revision}`,
    );
    const promoted = await promoteFactSet(db, { caller, releaseId: release, setId });
    invariant(promoted.ok, "the set is promoted");
}

const kinds = async (db: Db) => (await changes(db)).map((c) => (c.supported ? "rise" : "drop"));

test("promoting a release whose sets cover the open drop's builds records the rise", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(11_003);
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, rng, products);
        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");
        const next = await stageRelease(nativeDb, rng);
        // Covered on a release not yet current: nothing moves.
        await promoteSet(nativeDb, world.caller, next.id, UPDATED, 100);
        expect(await kinds(nativeDb)).toEqual(["drop"]);
        const promoted = await promoteRelease(nativeDb, {
            catalog: products,
            caller: world.caller,
            productId: ProductId.parse("cs2"),
            channel: ChannelId.parse("alpha"),
            number: next.number,
        });
        expect(promoted).toEqual({ ok: true, value: { changed: true } });
        expect(await kinds(nativeDb)).toEqual(["drop", "rise"]);
    });
});

test("promoting a release without sets for the game's builds records the drop", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(11_004);
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, rng, products);
        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        const next = await stageRelease(nativeDb, rng);
        const promoted = await promoteRelease(nativeDb, {
            catalog: products,
            caller: world.caller,
            productId: ProductId.parse("cs2"),
            channel: ChannelId.parse("alpha"),
            number: next.number,
        });
        expect(promoted.ok).toBe(true);
        expect(await kinds(nativeDb)).toEqual(["drop"]);
        await promoteSet(nativeDb, world.caller, next.id, GAME, 100);
        expect(await kinds(nativeDb)).toEqual(["drop", "rise"]);
    });
});
