import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { RoleId } from "@lucent/core/scalars";
import { z } from "zod";
import { execute, queryAll, sql } from "../src/base/db/pool.ts";
import {
    createShout,
    deleteShout,
    listShouts,
    purgeShouts,
} from "../src/members/community/shouts.ts";
import { catalog, grantRole, seedRole, steppedUp } from "./authority-fixtures.ts";
import { member, moderator } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();

type Db = Parameters<typeof listShouts>[0];
type Token = Parameters<typeof listShouts>[1];

async function feed(db: Db, token: Token) {
    const page = await listShouts(db, token, { catalog: products, productId: null, cursor: null });
    invariant(page.ok, "expected the feed");
    return page.value.items;
}

async function auditRows(db: Db, operation: string) {
    const rows = await queryAll(
        db,
        z.object({ target: z.record(z.string(), z.unknown()) }),
        sql`select target from audit where operation = ${operation} order by at, id`,
    );
    invariant(rows.ok, "expected the audit rows");
    return rows.value.map((row) => row.target);
}

test("an author deletes their own shout without an audit line, and nobody else's member can", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18401);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const mine = await createShout(db, alice.token, {
            catalog: products,
            productId: null,
            body: "hello",
        });
        invariant(mine.ok, "expected a shout");
        const aliceCaller = await steppedUp(db, alice.id);
        const bobCaller = await steppedUp(db, bob.id);

        // Someone else's shout is a missing one to a member without the permission.
        expect(await deleteShout({ db, caller: bobCaller, id: mine.value.id })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        expect((await feed(db, bob.token)).map((item) => item.id)).toEqual([mine.value.id]);

        expect(await deleteShout({ db, caller: aliceCaller, id: mine.value.id })).toEqual(
            ok(undefined),
        );
        expect(await feed(db, bob.token)).toEqual([]);
        // Again: nothing changes, and an unknown id is a missing one.
        expect(await deleteShout({ db, caller: aliceCaller, id: mine.value.id })).toEqual(
            ok(undefined),
        );
        expect(
            await deleteShout({
                db,
                caller: aliceCaller,
                id: "00000000-0000-4000-8000-000000000001",
            }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        expect(await auditRows(db, "shout.remove")).toEqual([]);
    });
});

test("staff with moderation:remove delete anyone's shout and it is audited once; other staff cannot", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18402);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const helper = await member(db, rng, "helper@lucent.test", "helper");
        const roleId = RoleId.parse("role_helper_only");
        await seedRole(db, { id: roleId, rank: 3, permissions: ["tickets:reply"] });
        await grantRole(db, { accountId: helper.id, roleId });
        const shout = await createShout(db, alice.token, {
            catalog: products,
            productId: null,
            body: "rude",
        });
        invariant(shout.ok, "expected a shout");

        // Holding another permission is not holding this one.
        expect(
            await deleteShout({
                db,
                caller: await steppedUp(db, helper.id),
                id: shout.value.id,
            }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        expect(await auditRows(db, "shout.remove")).toEqual([]);

        const listed = await feed(db, mod.token);
        expect(listed.map((item) => [item.id, item.isMine, item.canDelete])).toEqual([
            [shout.value.id, false, true],
        ]);
        expect((await feed(db, helper.token)).map((item) => item.canDelete)).toEqual([false]);
        expect((await feed(db, alice.token)).map((item) => item.canDelete)).toEqual([true]);

        expect(await deleteShout({ db, caller: mod.caller, id: shout.value.id })).toEqual(
            ok(undefined),
        );
        expect(await feed(db, alice.token)).toEqual([]);
        expect(await deleteShout({ db, caller: mod.caller, id: shout.value.id })).toEqual(
            ok(undefined),
        );
        const audit = await auditRows(db, "shout.remove");
        expect(audit).toEqual([{ accountId: alice.id, shoutId: shout.value.id }]);
    });
});

async function seedShouts(
    db: Db,
    rows: readonly {
        readonly author: string;
        readonly body: string;
        readonly minutesAgo: number;
    }[],
) {
    for (const row of rows) {
        const inserted = await execute(
            db,
            sql`insert into shout (author_id, body, created_at)
                values (${row.author}, ${row.body}, now() - ${row.minutesAgo}::int * interval '1 minute')`,
        );
        invariant(inserted.ok, "expected a shout row");
    }
}

test("a purge by username removes that account's shouts only, with one audit line holding the count", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18403);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        await seedShouts(db, [
            { author: alice.id, body: "a1", minutesAgo: 5 },
            { author: bob.id, body: "b1", minutesAgo: 4 },
            { author: alice.id, body: "a2", minutesAgo: 3 },
            { author: alice.id, body: "a3", minutesAgo: 2 },
        ]);
        // One of alice's is already gone: it is not counted again.
        const earlier = await execute(
            db,
            sql`update shout set removed_at = now() where body = 'a1'`,
        );
        invariant(earlier.ok, "expected the update");

        expect(
            await purgeShouts({ db, caller: mod.caller, target: { username: "nobody" } }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        expect(await auditRows(db, "shout.purge")).toEqual([]);

        expect(
            await purgeShouts({ db, caller: mod.caller, target: { username: "Alice" } }),
        ).toEqual(ok({ removed: 2 }));
        expect((await feed(db, bob.token)).map((item) => item.body)).toEqual(["b1"]);
        expect(await auditRows(db, "shout.purge")).toEqual([
            { accountId: alice.id, username: "alice", removed: 2 },
        ]);
        // Nothing left to remove: still one line per purge, with a zero.
        expect(
            await purgeShouts({ db, caller: mod.caller, target: { username: "alice" } }),
        ).toEqual(ok({ removed: 0 }));
    });
});

test("a purge of the last N removes the newest N not-yet-removed shouts of the whole feed", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18404);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        await seedShouts(db, [
            { author: alice.id, body: "oldest", minutesAgo: 50 },
            { author: bob.id, body: "older", minutesAgo: 40 },
            { author: alice.id, body: "gone", minutesAgo: 30 },
            { author: bob.id, body: "newer", minutesAgo: 20 },
            { author: alice.id, body: "newest", minutesAgo: 10 },
        ]);
        const gone = await execute(
            db,
            sql`update shout set removed_at = now() where body = 'gone'`,
        );
        invariant(gone.ok, "expected the update");

        expect(await purgeShouts({ db, caller: mod.caller, target: { last: 2 } })).toEqual(
            ok({ removed: 2 }),
        );
        // Newest first: what stays is the older two.
        expect((await feed(db, alice.token)).map((item) => item.body)).toEqual(["older", "oldest"]);
        expect(await auditRows(db, "shout.purge")).toEqual([
            { accountId: null, last: 2, removed: 2 },
        ]);

        // More than there are: all that remain.
        expect(await purgeShouts({ db, caller: mod.caller, target: { last: 100 } })).toEqual(
            ok({ removed: 2 }),
        );
        expect(await feed(db, alice.token)).toEqual([]);
    });
});

test("a purge needs moderation:remove", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18405);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        await seedShouts(db, [{ author: alice.id, body: "keep", minutesAgo: 1 }]);
        expect(
            await purgeShouts({
                db,
                caller: await steppedUp(db, alice.id),
                target: { last: 5 },
            }),
        ).toEqual(err({ code: "FORBIDDEN" }));
        expect((await feed(db, alice.token)).map((item) => item.body)).toEqual(["keep"]);
        expect(await auditRows(db, "shout.purge")).toEqual([]);
    });
});
