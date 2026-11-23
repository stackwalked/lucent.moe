import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { newEntitlementId, ProductId } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { webContract } from "@lucent/rpc/web";
import { z } from "zod";
import { mintSession } from "../src/auth/sessions.ts";
import { type Db, execute, queryAll, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { webProcedures } from "../src/listeners/internal/web-rpc.ts";
import { withMember } from "../src/notify/account.ts";
import { countUnread, listInbox, markRead, recordNotification } from "../src/notify/inbox.ts";
import { listPreferences, setPreference, setSubscription } from "../src/notify/preferences.ts";
import { catalog, seedAccount } from "./authority-fixtures.ts";
import { NO_LOG } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
async function member(db: Db, rng: SeededRng, email: string) {
    const id = await seedAccount(db, rng, email);
    const session = await withTx(db, (tx, txNow) =>
        mintSession(tx, { accountId: id, rng, client: null, purpose: "member", txNow }),
    );
    invariant(session.ok, "expected a session");
    const token = session.value.token;
    return {
        id,
        token,
        list: (cursor: string | null) => listInbox(db, token, { catalog: products, cursor }),
        unread: () => countUnread(db, token, products),
        mark: (entryId: string) => markRead(db, token, { catalog: products, entryId }),
        emit: (productId: ProductId) =>
            withTx(db, (tx) =>
                recordNotification(tx, id, {
                    kind: "product_status",
                    productId,
                    catalog: products,
                }),
            ),
    };
}

test("an inbox cursor, unread count and read receipt belong only to the session's account", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(5101);
        const alice = await member(db, rng, "alice@lucent.test");
        const bob = await member(db, rng, "bob@lucent.test");
        expect(
            await execute(
                db,
                sql`insert into inbox_entry (account_id, kind, created_at)
            select ${alice.id}, 'security', '2020-01-02 00:00:00Z'::timestamptz from generate_series(1, 27)`,
            ),
        ).toEqual(ok(27));
        expect(
            await execute(
                db,
                sql`insert into inbox_entry (account_id, kind, created_at)
            values (${bob.id}, 'security', '2020-01-01 00:00:00Z')`,
            ),
        ).toEqual(ok(1));
        const first = await alice.list(null);
        invariant(first.ok && first.value.nextCursor !== null, "expected a second page");
        expect(first.value.items).toHaveLength(25);
        const cursor = first.value.nextCursor;
        expect(await bob.list(cursor)).toEqual(ok({ items: [], nextCursor: null }));
        expect(await bob.mark(cursor)).toEqual(ok(undefined));
        expect(await alice.unread()).toEqual(ok({ count: 27 }));
        expect(await bob.unread()).toEqual(ok({ count: 1 }));
        expect(await alice.mark(cursor)).toEqual(ok(undefined));
        expect(await alice.mark(cursor)).toEqual(ok(undefined));
        expect(await alice.unread()).toEqual(ok({ count: 26 }));
        expect(
            await execute(
                db,
                sql`insert into inbox_entry (account_id, kind, created_at)
            values (${alice.id}, 'security', '2020-01-03 00:00:00Z')`,
            ),
        ).toEqual(ok(1));
        const second = await alice.list(cursor);
        invariant(second.ok, "expected the older entries");
        expect(second.value.nextCursor).toBeNull();
        expect(second.value.items).toHaveLength(2);
        expect(
            new Set([...first.value.items, ...second.value.items].map((row) => row.id)).size,
        ).toBe(27);
    });
});

test("a notification rolls back with its writer and follows only the recipient's choices", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(5102);
        const alice = await member(db, rng, "alice@lucent.test");
        const bob = await member(db, rng, "bob@lucent.test");
        const productId = ProductId.parse("lucent-loader");
        const choice = { productId, catalog: products };
        const preference = { kind: "product_status", inbox: false, mail: true } as const;
        expect(await setSubscription(db, alice.token, { ...choice, following: true })).toEqual(
            ok(undefined),
        );
        expect(await setPreference(db, bob.token, preference)).toEqual(ok(undefined));
        expect(await listPreferences(db, bob.token, products)).toEqual(
            ok({
                security: { inbox: true, mail: true },
                product_status: { inbox: false, mail: true },
                subscriptions: [],
            }),
        );
        const rolledBack = await withMember(db, alice.token, async (tx, id) => {
            expect(await recordNotification(tx, id, { kind: "product_status", ...choice })).toEqual(
                ok({ inbox: true, mail: false }),
            );
            return err({ code: "ABORT" });
        });
        expect(rolledBack).toEqual(err({ code: "ABORT" }));
        expect(await alice.unread()).toEqual(ok({ count: 0 }));
        expect(await bob.emit(productId)).toEqual(ok({ inbox: false, mail: false }));
        expect(await alice.emit(productId)).toEqual(ok({ inbox: true, mail: false }));
        expect(await bob.unread()).toEqual(ok({ count: 0 }));
        expect(await alice.unread()).toEqual(ok({ count: 1 }));
        expect(await setPreference(db, alice.token, preference)).toEqual(ok(undefined));
        expect(await alice.emit(productId)).toEqual(ok({ inbox: false, mail: true }));
        expect(await alice.unread()).toEqual(ok({ count: 1 }));
        expect(
            await withMember(db, alice.token, (tx, id) =>
                recordNotification(tx, id, { kind: "security", productId: null }),
            ),
        ).toEqual(ok({ inbox: true, mail: true }));
        expect(await alice.unread()).toEqual(ok({ count: 2 }));
        expect(await setSubscription(db, alice.token, { ...choice, following: false })).toEqual(
            ok(undefined),
        );
        expect(await alice.emit(productId)).toEqual(ok({ inbox: false, mail: false }));
        expect(
            await queryAll(
                db,
                z.object({ recipient: z.string() }),
                sql`select recipient from mail_outbox`,
            ),
        ).toEqual(ok([{ recipient: "alice@lucent.test" }, { recipient: "alice@lucent.test" }]));
        expect(
            await execute(db, sql`update account set is_locked = true where id = ${alice.id}`),
        ).toEqual(ok(1));
        expect(await alice.list(null)).toEqual(err({ code: "SESSION_INVALID" }));
        expect(await setPreference(db, alice.token, preference)).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
    });
});

test("losing a seed entitlement hides its follow and history, suppresses new delivery and still allows unfollow", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(5103);
        const alice = await member(db, rng, "alice@lucent.test");
        const auth = await createTestAuthDeps(db, rng);
        const peerKey = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
        const app = mountInternalRpc({
            path: "/rpc",
            peerKey,
            procedures: webProcedures,
            createContext: () => Promise.resolve(ok({ catalog: products, auth, logger: NO_LOG })),
            onUnhandledError: () => {},
        });
        const client = createRpcClient(webContract, {
            endpointUrl: "http://localhost/rpc",
            peerKey,
            fetcher: async (req) => await app.fetch(req),
        });
        const caller = { session: alice.token };
        const seed = ProductId.parse("cs2");
        const missing = ProductId.parse("absent");
        const change = (productId: ProductId, following: "follow" | "unfollow") =>
            client.call(
                "preferences.subscriptions.set",
                { productId, following: following === "follow" },
                caller,
            );
        const follows = async () => {
            const response = await client.call("preferences.channels.list", {}, caller);
            invariant(response.ok, "preferences must load");
            return response.value.subscriptions;
        };
        expect(await change(missing, "follow")).toEqual(err({ code: "NOT_FOUND" }));
        expect(await change(seed, "follow")).toEqual(err({ code: "NOT_FOUND" }));
        expect(await follows()).toEqual([]);
        const entitlement = newEntitlementId(rng);
        expect(
            await execute(
                db,
                sql`insert into entitlement (id, account_id, valid_from)
            values (${entitlement}, ${alice.id}, now())`,
            ),
        ).toEqual(ok(1));
        expect(
            await execute(
                db,
                sql`insert into entitlement_product (entitlement_id, product_id, features, channels)
            values (${entitlement}, ${seed}, '"*"'::jsonb, '{stable}')`,
            ),
        ).toEqual(ok(1));
        expect(await change(seed, "follow")).toEqual(ok({}));
        expect(await follows()).toEqual([seed]);
        expect(
            await client.call(
                "preferences.channels.set",
                { kind: "product_status", inbox: true, mail: true },
                caller,
            ),
        ).toEqual(ok({}));
        expect(
            await execute(
                db,
                sql`insert into inbox_entry (account_id, kind, created_at)
            select ${alice.id}, 'security', '2020-01-01'::timestamptz from generate_series(1, 26)`,
            ),
        ).toEqual(ok(26));
        expect(await alice.emit(seed)).toEqual(ok({ inbox: true, mail: true }));
        const visible = await alice.list(null);
        invariant(
            visible.ok && visible.value.items[0]?.productId === seed,
            "seed notice visible to current holder",
        );
        const entry = visible.value.items[0].id;
        // Expiry at the exact PostgreSQL transaction timestamp must already suppress delivery.
        // Converting that time to EpochMs and back can put the check before the deadline.
        expect(
            await withMember(db, alice.token, async (tx, id) => {
                const expired = await execute(
                    tx,
                    sql`update entitlement set valid_until = now() where id = ${entitlement}`,
                );
                if (!expired.ok) return expired;
                return recordNotification(tx, id, {
                    kind: "product_status",
                    productId: seed,
                    catalog: products,
                });
            }),
        ).toEqual(ok({ inbox: false, mail: false }));
        expect(
            await execute(db, sql`update entitlement set status='revoked' where id=${entitlement}`),
        ).toEqual(ok(1));
        expect(await change(seed, "follow")).toEqual(err({ code: "NOT_FOUND" }));
        expect(await follows()).toEqual([]);
        expect(await alice.emit(seed)).toEqual(ok({ inbox: false, mail: false }));
        expect(await alice.unread()).toEqual(ok({ count: 26 }));
        expect(await alice.list(entry)).toEqual(ok({ items: [], nextCursor: null }));
        expect(await alice.mark(entry)).toEqual(ok(undefined));
        const hidden = await alice.list(null);
        invariant(hidden.ok && hidden.value.nextCursor !== null, "security notices still page");
        expect(hidden.value.items.map((row) => row.kind)).toEqual(
            Array.from({ length: 25 }, () => "security"),
        );
        expect(await change(seed, "unfollow")).toEqual(ok({}));
        expect(
            await execute(
                db,
                sql`update entitlement set status='active', valid_until=null where id=${entitlement}`,
            ),
        ).toEqual(ok(1));
        expect(await follows()).toEqual([]);
        expect(await alice.unread()).toEqual(ok({ count: 27 }));
    });
});
