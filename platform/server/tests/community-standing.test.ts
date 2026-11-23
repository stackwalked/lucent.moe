import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { withMemberAt } from "../src/community/member.ts";
import { listOwnRestrictions, mayPostHere } from "../src/community/standing.ts";
import { execute, queryOne, sql } from "../src/db/pool.ts";
import {
    expireRestrictions,
    liftRestriction,
    listRestrictions,
    setRestriction,
} from "../src/moderation/restrictions.ts";
import { catalog, dbNow } from "./authority-fixtures.ts";
import { member, moderator } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const cs2 = ProductId.parse("cs2");
const loader = ProductId.parse("lucent-loader");

test("a barred account cannot post in the named product, can post elsewhere, and keeps its session and licence", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9101);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const statusBefore = await queryOne(
            db,
            z.object({ status: z.string() }),
            sql`select status from account where id = ${alice.id}`,
        );
        const set = await setRestriction({
            db,
            catalog: products,
            caller: mod.caller,
            username: "Alice",
            kind: "barred",
            productId: cs2,
            reason: "spam",
            endsAt: null,
        });
        expect(set.ok).toBe(true);
        const may = (productId: ProductId | null, surface: "guide" | "shout" = "guide") =>
            withMemberAt(db, alice.token, async (tx, accountId, txNow) =>
                mayPostHere(tx, {
                    accountId,
                    surface,
                    productId,
                    txNow,
                }),
            );
        expect(await may(cs2)).toEqual(
            err({ code: "POSTING_RESTRICTED", kind: "barred", productId: cs2, endsAt: null }),
        );
        expect(await may(loader)).toEqual(ok(null));
        expect(await may(null, "shout")).toEqual(ok(null));
        const own = await listOwnRestrictions(db, alice.token);
        invariant(own.ok, "expected the member's own list");
        expect(own.value.restrictions).toEqual([
            { id: expect.any(String), kind: "barred", productId: cs2, endsAt: null },
        ]);
        expect(
            await queryOne(
                db,
                z.object({ status: z.string() }),
                sql`select status from account where id = ${alice.id}`,
            ),
        ).toEqual(statusBefore);
        // The session was used above and is still live: restricting ended nothing.
        const audited = await queryOne(
            db,
            z.object({ n: z.coerce.number() }),
            sql`select count(*) as n from audit where operation = 'community.restrict'`,
        );
        expect(audited).toEqual(ok({ n: 1 }));
    });
});

test("lifting and expiry end a restriction; a restriction past its end never applies", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9102);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const base = {
            db,
            catalog: products,
            caller: mod.caller,
            kind: "muted",
            productId: null,
            reason: "rude",
        } as const;
        const short = await setRestriction({
            ...base,
            username: "alice",
            endsAt: EpochMs.parse((await dbNow(db)) + 60_000),
        });
        invariant(short.ok, "expected the restriction");
        const forever = await setRestriction({ ...base, username: "bob", endsAt: null });
        invariant(forever.ok, "expected the restriction");
        expect(await liftRestriction({ db, caller: mod.caller, id: forever.value.id })).toEqual(
            ok(null),
        );
        expect(await liftRestriction({ db, caller: mod.caller, id: forever.value.id })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        expect(await listOwnRestrictions(db, bob.token)).toEqual(ok({ restrictions: [] }));
        // Time passes in the database, not in the process.
        await execute(
            db,
            sql`update community_restriction set created_at = created_at - interval '2 minutes',
                ends_at = ends_at - interval '2 minutes' where id = ${short.value.id}::uuid`,
        );
        expect(await listOwnRestrictions(db, alice.token)).toEqual(ok({ restrictions: [] }));
        expect(await expireRestrictions(db)).toEqual(ok(1));
        expect(await expireRestrictions(db)).toEqual(ok(0));
        const listed = await listRestrictions(db, { caller: mod.caller, cursor: null });
        expect(listed).toEqual(ok({ items: [], nextCursor: null }));
    });
});

test("only moderation:remove restricts, and never an account of equal or higher rank", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9103);
        const mod = await moderator(db, rng, "mod@lucent.test", 5);
        const peer = await moderator(db, rng, "peer@lucent.test", 5);
        await execute(db, sql`update account set username = 'peer' where id = ${peer.id}`);
        const plain = await member(db, rng, "plain@lucent.test", "plain");
        const base = {
            db,
            catalog: products,
            kind: "barred",
            productId: null,
            reason: "x",
            endsAt: null,
        } as const;
        expect(
            await setRestriction({
                ...base,
                caller: { accountId: plain.id, stepUpAt: null, client: null },
                username: "peer",
            }),
        ).toEqual(err({ code: "FORBIDDEN" }));
        expect(await setRestriction({ ...base, caller: mod.caller, username: "peer" })).toEqual(
            err({ code: "FORBIDDEN" }),
        );
        expect(await setRestriction({ ...base, caller: mod.caller, username: "nobody" })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        expect(
            await setRestriction({
                ...base,
                caller: mod.caller,
                username: "plain",
                productId: ProductId.parse("not-a-product"),
            }),
        ).toEqual(err({ code: "UNKNOWN_PRODUCT" }));
        expect(
            await setRestriction({
                ...base,
                caller: mod.caller,
                username: "plain",
                endsAt: EpochMs.parse(1),
            }),
        ).toEqual(err({ code: "INVALID_WINDOW" }));
        expect(
            await listRestrictions(db, {
                caller: { accountId: plain.id, stepUpAt: null, client: null },
                cursor: null,
            }),
        ).toEqual(err({ code: "FORBIDDEN" }));
    });
});
