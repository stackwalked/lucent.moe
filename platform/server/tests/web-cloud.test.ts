import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { newEntitlementId, newOperationId } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { webContract } from "@lucent/rpc/web";
import { execute, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { createItem } from "../src/delivery/cloud/items.ts";
import { listCloudProducts } from "../src/delivery/cloud/member.ts";
import { webProcedures } from "../src/edge/listeners/internal/web-rpc.ts";
import { endSession } from "../src/identity/auth/sessions.ts";
import { hashToken } from "../src/identity/auth/tokens.ts";
import { memberSession } from "./auth-fixtures.ts";
import { catalog, product, seedAccount } from "./authority-fixtures.ts";
import { NO_LOG } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

test("cloud RPCs derive ownership from the member and import only with current product access", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(701);
        const auth = await createTestAuthDeps(db, rng);
        const owner = await seedAccount(db, rng, "owner@cloud.test");
        const other = await seedAccount(db, rng, "other@cloud.test");
        const alice = { session: await memberSession(auth, owner) };
        const bob = { session: await memberSession(auth, other) };
        const products = new Map(catalog());
        const cs2 = product("cs2");
        const p = { productId: cs2.id };
        const limits = {
            maxItems: 2,
            maxVersionBytes: 100,
            maxStoredBytes: 500,
            maxVersionsPerItem: 4,
        };
        const peerKey = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
        const app = mountInternalRpc({
            path: "/rpc",
            peerKey,
            procedures: webProcedures,
            createContext: () =>
                Promise.resolve(
                    ok({ auth, catalog: products, cloudLimits: limits, logger: NO_LOG }),
                ),
            onUnhandledError: () => {},
        });
        const client = createRpcClient(webContract, {
            endpointUrl: "http://localhost/rpc",
            peerKey,
            fetcher: (req) => Promise.resolve(app.fetch(req)),
        });
        const grant = async (accountId: typeof owner) => {
            const id = newEntitlementId(rng);
            expect(
                (
                    await execute(
                        db,
                        sql`insert into entitlement (id, account_id,valid_from) values (${id},${accountId},now() - interval '1 hour')`,
                    )
                ).ok,
            ).toBe(true);
            expect(
                (
                    await execute(
                        db,
                        sql`insert into entitlement_product (entitlement_id,product_id,features,channels) values (${id},${p.productId},'"*"'::jsonb,'{stable}')`,
                    )
                ).ok,
            ).toBe(true);
            return id;
        };
        await grant(owner);
        const item = await withTx(db, (tx) =>
            createItem(tx, {
                ...p,
                accountId: owner,
                limits,
                kind: "script",
                name: "opaque",
                bytes: Uint8Array.of(0, 255),
            }),
        );
        invariant(item.ok, "seeded owned item");
        const target = { ...p, itemId: item.value.itemId };
        const link = await client.call("cloud.shares.create", target, alice);
        invariant(link.ok, "owner shared snapshot");
        const copy = () =>
            client.call("cloud.shares.import", { ...p, token: link.value.token }, bob);
        const missing = err({ code: "NOT_FOUND" });
        expect(await client.call("cloud.products.list", {}, bob)).toEqual(
            ok({ products: [], canAppend: true }),
        );
        expect(await copy()).toEqual(missing);
        const grantId = await grant(other);
        expect(await client.call("cloud.items.list", p, bob)).toEqual(ok([]));
        expect(await client.call("cloud.items.history", target, bob)).toEqual(missing);
        expect(
            await client.call("cloud.items.rename", { ...target, name: "x", base: 1 }, bob),
        ).toEqual(missing);
        expect(
            await client.call("cloud.shares.revoke", { ...p, shareId: link.value.shareId }, bob),
        ).toEqual(missing);
        expect(await client.call("cloud.items.delete", target, bob)).toEqual(missing);
        const copied = await copy();
        invariant(copied.ok, "entitled recipient imported");
        expect(copied.value.itemId).not.toBe(target.itemId);
        const ownCopy = { ...p, itemId: copied.value.itemId };
        expect(
            await client.call("cloud.items.rename", { ...ownCopy, name: "mine", base: 1 }, bob),
        ).toEqual(ok({ revision: 2, conflict: false }));
        expect(
            await client.call("cloud.items.restore", { ...ownCopy, base: 2, revision: 1 }, bob),
        ).toEqual(ok({ revision: 3, conflict: false }));
        expect(await client.call("cloud.items.history", target, alice)).toEqual(
            ok({
                versions: [{ itemId: target.itemId, name: "opaque", kind: "script", revision: 1 }],
                shares: [{ shareId: link.value.shareId, revision: 1 }],
            }),
        );
        for (const state of ["announced", "retired"] as const) {
            products.set(cs2.id, { ...cs2, state });
            expect(await copy()).toEqual(missing);
            expect(await client.call("cloud.items.list", p, bob)).toEqual(
                ok([{ itemId: ownCopy.itemId, revision: 3, name: "opaque", kind: "script" }]),
            );
        }
        products.set(cs2.id, cs2);
        expect(
            (await execute(db, sql`update entitlement set valid_until=now() where id=${grantId}`))
                .ok,
        ).toBe(true);
        expect(await copy()).toEqual(missing);
        expect((await client.call("cloud.items.history", ownCopy, bob)).ok).toBe(true);
        await grant(other);
        expect(
            await client.call("cloud.shares.revoke", { ...p, shareId: link.value.shareId }, alice),
        ).toEqual(ok({}));
        expect(await copy()).toEqual(missing);
        expect(await client.call("cloud.items.delete", ownCopy, bob)).toEqual(ok({}));
        expect(
            (await execute(db, sql`update account set is_locked=true where id=${owner}`)).ok,
        ).toBe(true);
        expect(await client.call("cloud.items.list", p, alice)).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
    });
});

test("a member keeps their items when the product retires or the entitlement lapses, and adds nothing", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(703);
        const auth = await createTestAuthDeps(db, rng);
        const owner = await seedAccount(db, rng, "keeper@cloud.test");
        const alice = { session: await memberSession(auth, owner) };
        const products = new Map(catalog());
        const cs2 = product("cs2");
        const p = { productId: cs2.id };
        const limits = {
            maxItems: 4,
            maxVersionBytes: 100,
            maxStoredBytes: 500,
            maxVersionsPerItem: 4,
        };
        const peerKey = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
        const app = mountInternalRpc({
            path: "/rpc",
            peerKey,
            procedures: webProcedures,
            createContext: () =>
                Promise.resolve(
                    ok({ auth, catalog: products, cloudLimits: limits, logger: NO_LOG }),
                ),
            onUnhandledError: () => {},
        });
        const client = createRpcClient(webContract, {
            endpointUrl: "http://localhost/rpc",
            peerKey,
            fetcher: (req) => Promise.resolve(app.fetch(req)),
        });
        const entitlement = newEntitlementId(rng);
        expect(
            (
                await execute(
                    db,
                    sql`insert into entitlement (id, account_id, valid_from) values (${entitlement}, ${owner}, now() - interval '1 hour')`,
                )
            ).ok,
        ).toBe(true);
        expect(
            (
                await execute(
                    db,
                    sql`insert into entitlement_product (entitlement_id, product_id, features, channels) values (${entitlement}, ${p.productId}, '"*"'::jsonb, '{stable}')`,
                )
            ).ok,
        ).toBe(true);
        const made = async (name: string) => {
            const created = await client.call(
                "cloud.items.create",
                { ...p, operationId: newOperationId(rng), name, kind: "script" },
                alice,
            );
            invariant(created.ok, "owner created an item while eligible");
            return { ...p, itemId: created.value.itemId };
        };
        const kept = await made("kept");
        const doomed = await made("doomed");
        const link = await client.call("cloud.shares.create", kept, alice);
        invariant(link.ok, "owner shared while eligible");
        const missing = err({ code: "NOT_FOUND" });
        const refusedWrites = async () => {
            expect(
                await client.call(
                    "cloud.items.create",
                    { ...p, operationId: newOperationId(rng), name: "new", kind: "script" },
                    alice,
                ),
            ).toEqual(missing);
            expect(
                await client.call("cloud.items.rename", { ...kept, name: "x", base: 1 }, alice),
            ).toEqual(missing);
            expect(
                await client.call("cloud.items.restore", { ...kept, base: 1, revision: 1 }, alice),
            ).toEqual(missing);
            expect(await client.call("cloud.shares.create", kept, alice)).toEqual(missing);
            expect(
                await client.call("cloud.shares.import", { ...p, token: link.value.token }, alice),
            ).toEqual(missing);
        };

        products.set(cs2.id, { ...cs2, state: "retired" });
        expect(await client.call("cloud.products.list", {}, alice)).toEqual(
            ok({ products: [{ id: cs2.id, name: cs2.name, canCreate: false }], canAppend: true }),
        );
        await refusedWrites();
        const listed = await client.call("cloud.items.list", p, alice);
        invariant(listed.ok, "a retired product still lists the held items");
        expect(listed.value.map((item) => item.itemId).sort()).toEqual(
            [kept.itemId, doomed.itemId].sort(),
        );
        const history = await client.call("cloud.items.history", kept, alice);
        invariant(history.ok, "a retired product still reads history");
        expect(history.value.shares).toEqual([{ shareId: link.value.shareId, revision: 1 }]);
        expect(
            await client.call("cloud.shares.revoke", { ...p, shareId: link.value.shareId }, alice),
        ).toEqual(ok({}));
        expect(await client.call("cloud.items.delete", doomed, alice)).toEqual(ok({}));

        products.set(cs2.id, cs2);
        expect(
            (
                await execute(
                    db,
                    sql`update entitlement set valid_until = now() where id = ${entitlement}`,
                )
            ).ok,
        ).toBe(true);
        expect(await client.call("cloud.products.list", {}, alice)).toEqual(
            ok({ products: [{ id: cs2.id, name: cs2.name, canCreate: false }], canAppend: true }),
        );
        await refusedWrites();
        expect(await client.call("cloud.items.list", p, alice)).toEqual(
            ok([{ itemId: kept.itemId, revision: 1, name: "kept", kind: "script" }]),
        );
        expect(await client.call("cloud.items.delete", kept, alice)).toEqual(ok({}));
        expect(await client.call("cloud.items.list", p, alice)).toEqual(missing);
        expect(await client.call("cloud.products.list", {}, alice)).toEqual(
            ok({ products: [], canAppend: true }),
        );
    });
});
test("a pending sign-out prevents cloud access from using the old session snapshot", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(
        async ({ nativeDb, browserDb }) => {
            const rng = createSeededRng(707);
            const auth = await createTestAuthDeps(nativeDb, rng);
            const member = await memberSession(
                auth,
                await seedAccount(nativeDb, rng, "leaving@cloud.test"),
            );
            const hash = await hashToken(member);
            const list = () => listCloudProducts(browserDb, member, catalog());
            const ended = await withTx(nativeDb, async (tx) => {
                const closing = await endSession(tx, hash);
                if (!closing.ok) return closing;
                expect(await list()).toEqual(err({ code: "STATEMENT_TIMEOUT" }));
                return closing;
            });
            expect(ended.ok).toBe(true);
            expect(await list()).toEqual(err({ code: "SESSION_INVALID" }));
        },
        { browserTimeoutMs: 150 },
    );
});
