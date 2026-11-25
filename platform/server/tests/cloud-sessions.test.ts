import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { type AccountId, ProductId } from "@lucent/core/scalars";
import { createItem, listHistory, readItem } from "../src/cloud/items.ts";
import {
    listSessionItems,
    readSessionItem,
    type SessionWrite,
    writeSessionItem,
} from "../src/cloud/sessions.ts";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { seedAccount } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    createTestModule,
    enroll,
    entitledMember,
    publishBoth,
    refusalCodeOf,
    signIn,
    startOk,
} from "./native-fixtures.ts";

const limits = { maxItems: 3, maxVersionBytes: 12, maxStoredBytes: 96, maxVersionsPerItem: 8 };
const cs2 = ProductId.parse("cs2");
const missing = err({ code: "NOT_FOUND" });

function value<T>(result: Result<T, unknown>) {
    invariant(result.ok, `expected success: ${JSON.stringify(result)}`);
    return result.value;
}

// A cs2 session running for a fresh entitled account, as the loader and module open one.
async function running(db: Db, seed: number) {
    const rng = createSeededRng(seed);
    const harness = await createNativeHarness(db, rng);
    const releases = await publishBoth(db, rng);
    const member = await entitledMember(harness, {
        email: "cloud-session@lucent.test",
        channels: ["alpha"],
    });
    const loader = createTestLoader(harness, await createTestDevice(rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    const started = await startOk(loader, releases);
    const module = createTestModule(rng, harness.signer.publicKey);
    const opened = await loader.send({
        method: "POST",
        path: `${started.path}/session`,
        body: await module.hello(releases.module.id),
    });
    invariant(opened.status === 200, `the session was refused: ${refusalCodeOf(opened)}`);
    await module.acceptSession(opened.bytes);
    return { rng, accountId: member.accountId, sessionId: module.session() };
}

type Caller = { readonly accountId: AccountId; readonly sessionId: Uint8Array };

const write = (db: Db, caller: Caller, item: SessionWrite) =>
    withTx(db, (tx, txNow) => writeSessionItem(tx, { ...caller, txNow, write: item, limits }));
const list = (db: Db, caller: Caller) =>
    withTx(db, (tx, txNow) => listSessionItems(tx, { ...caller, txNow }));
const read = (db: Db, caller: Caller, itemId: string, revision?: number) =>
    withTx(db, (tx, txNow) =>
        readSessionItem(tx, {
            ...caller,
            txNow,
            itemId,
            ...(revision === undefined ? {} : { revision }),
        }),
    );

const config = (bytes: Uint8Array): SessionWrite => ({
    type: "create",
    kind: "config",
    name: "cfg",
    bytes,
});

test("a session reaches only its own account's items for its own product, and only while it runs", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const session = await running(db, 7_101);
        const other = await seedAccount(db, session.rng, "neighbour@lucent.test");
        const foreign = { kind: "config", name: "x", bytes: Uint8Array.of(9), limits } as const;
        const elsewhere = [
            { accountId: session.accountId, productId: ProductId.parse("other") },
            { accountId: other, productId: cs2 },
        ];
        const theirs = [];
        for (const scope of elsewhere)
            theirs.push(value(await withTx(db, (tx) => createItem(tx, { ...scope, ...foreign }))));
        const own = value(await write(db, session, config(Uint8Array.of(1, 2))));

        expect(value(await list(db, session))).toEqual([
            { itemId: own.itemId, kind: "config", revision: 1, name: "cfg", size: 2 },
        ]);
        for (const { itemId } of theirs) {
            expect(await read(db, session, itemId)).toEqual(missing);
            expect(
                await write(db, session, {
                    type: "replace",
                    itemId,
                    base: 1,
                    bytes: Uint8Array.of(0),
                }),
            ).toEqual(missing);
        }
        for (const [index, { itemId }] of theirs.entries()) {
            const scope = elsewhere[index];
            invariant(scope !== undefined, "each foreign item has its scope");
            expect(value(await readItem(db, { ...scope, itemId })).bytes).toEqual(foreign.bytes);
        }

        const claimed = { accountId: other, sessionId: session.sessionId };
        expect(await list(db, claimed)).toEqual(missing);
        expect(await read(db, claimed, own.itemId)).toEqual(missing);

        const ended = await execute(
            db,
            sql`update runtime_session set ended_at = now(), end_reason = 'closed'
            where id = ${session.sessionId}`,
        );
        expect(ended).toEqual(ok(1));
        expect(await list(db, session)).toEqual(missing);
        expect(await read(db, session, own.itemId)).toEqual(missing);
        expect(await write(db, session, config(Uint8Array.of(3)))).toEqual(missing);
    });
});

test("a suspended account's session neither reads nor writes before the transport ends it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const session = await running(db, 7_102);
        const own = value(await write(db, session, config(Uint8Array.of(1))));
        const suspended = await execute(
            db,
            sql`update account set status = 'suspended' where id = ${session.accountId}`,
        );
        expect(suspended).toEqual(ok(1));
        const refused = err({ code: "ACCOUNT_SUSPENDED" });
        expect(await list(db, session)).toEqual(refused);
        expect(await read(db, session, own.itemId)).toEqual(refused);
        expect(await write(db, session, config(Uint8Array.of(2)))).toEqual(refused);
    });
});

test("two session writes from the same base both land: the later is current and flagged, the earlier stays in history", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const session = await running(db, 7_103);
        const { itemId } = value(await write(db, session, config(Uint8Array.of(0))));
        const writes = await Promise.all(
            [41, 42].map(async (n) => {
                const bytes = Uint8Array.of(n);
                const result = value(
                    await write(db, session, { type: "replace", itemId, base: 1, bytes }),
                );
                return { bytes, ...result };
            }),
        );
        expect(writes.map((w) => w.revision).sort()).toEqual([2, 3]);
        const [loser, winner] = [...writes].sort((a, b) => a.revision - b.revision);
        invariant(loser !== undefined && winner !== undefined, "both writes answered");
        expect([loser.conflict, winner.conflict]).toEqual([false, true]);
        expect(value(await read(db, session, itemId)).bytes).toEqual(winner.bytes);
        expect(value(await read(db, session, itemId, loser.revision)).bytes).toEqual(loser.bytes);
        const scope = { accountId: session.accountId, productId: cs2, itemId };
        expect(value(await listHistory(db, scope)).map((v) => v.revision)).toEqual([3, 2, 1]);
    });
});

test("session writes meet the same count, size and storage caps as the site's", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const session = await running(db, 7_104);
        const { itemId } = value(await write(db, session, config(new Uint8Array(9))));
        expect(await write(db, session, config(new Uint8Array(10)))).toEqual(
            err({ code: "SIZE_LIMIT" }),
        );
        value(await write(db, session, config(new Uint8Array(9))));
        value(await write(db, session, config(new Uint8Array(9))));
        expect(await write(db, session, config(Uint8Array.of(1)))).toEqual(
            err({ code: "ITEM_LIMIT" }),
        );
        for (const base of [1, 2, 3, 4, 5]) {
            value(
                await write(db, session, {
                    type: "replace",
                    itemId,
                    base,
                    bytes: new Uint8Array(9),
                }),
            );
        }
        expect(
            await write(db, session, {
                type: "replace",
                itemId,
                base: 6,
                bytes: new Uint8Array(9),
            }),
        ).toEqual(err({ code: "STORAGE_LIMIT" }));
    });
});
