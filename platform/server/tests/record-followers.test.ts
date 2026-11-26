import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import type { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { tellFollowers } from "../src/record/followers.ts";
import { scalar, seedAccount } from "./authority-fixtures.ts";
import { GAME, OTHER_GAME } from "./fact-set-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import { liveCatalog, supportWorld, UPDATED } from "./record-fixtures.ts";

async function follower(
    db: Db,
    rng: SeededRng,
    params: { readonly email: string; readonly follows: boolean; readonly mail: boolean },
): Promise<AccountId> {
    const id = await seedAccount(db, rng, params.email);
    if (params.follows) {
        await execute(
            db,
            sql`insert into product_subscription (account_id, product_id) values (${id}, 'cs2')`,
        );
    }
    if (params.mail) {
        await execute(
            db,
            sql`insert into notification_preference (account_id, kind, inbox, mail, discord)
                values (${id}, 'product_status', true, true, false)`,
        );
    }
    return id;
}

const inboxOf = (db: Db, id: AccountId) =>
    scalar(
        db,
        z.coerce.number(),
        sql`select count(*) as value from inbox_entry
            where account_id = ${id} and kind = 'product_status' and product_id = 'cs2'`,
    );

const mailTo = (db: Db, email: string) =>
    scalar(
        db,
        z.coerce.number(),
        sql`select count(*) as value from mail_outbox where recipient = ${email}`,
    );

test("each follower is told once per support drop, by inbox and by mail as they chose, and someone following nothing is told nothing", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb, browserDb }) => {
        const rng = createSeededRng(11_101);
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, rng, products);
        const alice = await follower(browserDb, rng, {
            email: "alice@lucent.test",
            follows: true,
            mail: true,
        });
        const bob = await follower(browserDb, rng, {
            email: "bob@lucent.test",
            follows: true,
            mail: false,
        });
        const carol = await follower(browserDb, rng, {
            email: "carol@lucent.test",
            follows: false,
            mail: true,
        });
        const tell = () => tellFollowers(browserDb, { catalog: products, mail: true });

        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await tell()).toEqual({ ok: true, value: { told: 0, givenUp: [] } });

        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");
        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");
        // Two runners at once still tell each follower once.
        const [first, second] = await Promise.all([tell(), tell()]);
        expect((first.ok ? first.value.told : -1) + (second.ok ? second.value.told : -1)).toBe(2);
        expect(await tell()).toEqual({ ok: true, value: { told: 0, givenUp: [] } });

        expect(await inboxOf(browserDb, alice)).toBe(1);
        expect(await mailTo(browserDb, "alice@lucent.test")).toBe(1);
        expect(await inboxOf(browserDb, bob)).toBe(1);
        expect(await mailTo(browserDb, "bob@lucent.test")).toBe(0);
        expect(await inboxOf(browserDb, carol)).toBe(0);
        expect(await mailTo(browserDb, "carol@lucent.test")).toBe(0);

        // The recovery tells nobody.
        await world.support(UPDATED);
        expect(await tell()).toEqual({ ok: true, value: { told: 0, givenUp: [] } });
        expect(await inboxOf(browserDb, alice)).toBe(1);
        expect(await inboxOf(browserDb, bob)).toBe(1);
    });
});

test("a drop already recovered from before anyone was told tells nobody", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb, browserDb }) => {
        const rng = createSeededRng(11_102);
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, rng, products);
        const alice = await follower(browserDb, rng, {
            email: "alice@lucent.test",
            follows: true,
            mail: true,
        });

        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");
        await world.support(UPDATED);

        expect(await tellFollowers(browserDb, { catalog: products, mail: true })).toEqual({
            ok: true,
            value: { told: 0, givenUp: [] },
        });
        expect(await inboxOf(browserDb, alice)).toBe(0);
        expect(
            await scalar(
                browserDb,
                z.coerce.number(),
                sql`select count(*) as value from product_support_change where notified_at is null`,
            ),
        ).toBe(0);
    });
});

const changesOf = (db: Db) =>
    scalar(
        db,
        z.string(),
        sql`select coalesce(string_agg(case when supported then 'rise' else 'drop' end, ' '
                                       order by id), '') as value
            from product_support_change`,
    );

test("members on the old and the new build taking turns record one drop and tell each follower once", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb, browserDb }) => {
        const rng = createSeededRng(11_103);
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, rng, products);
        const alice = await follower(browserDb, rng, {
            email: "alice@lucent.test",
            follows: true,
            mail: false,
        });
        const tell = () => tellFollowers(browserDb, { catalog: products, mail: true });

        await world.support(GAME);
        expect(await world.start(GAME, "first")).toBe("NOT_A_REFUSAL");
        for (let turn = 0; turn < 3; turn += 1) {
            expect(await world.start(UPDATED, "second")).toBe("GAME_BUILD_UNSUPPORTED");
            expect(await tell()).toMatchObject({ ok: true });
            expect(await world.start(GAME, "first")).toBe("NOT_A_REFUSAL");
            expect(await tell()).toMatchObject({ ok: true });
        }
        expect(await changesOf(browserDb)).toBe("drop");
        expect(await inboxOf(browserDb, alice)).toBe(1);
    });
});

test("a start reporting only some of the game's modules records nothing", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb, browserDb }) => {
        const world = await supportWorld(nativeDb, createSeededRng(11_104), liveCatalog());
        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await world.start(OTHER_GAME)).toBe("NOT_A_REFUSAL");
        expect(await world.start(UPDATED, "second")).toBe("GAME_BUILD_UNSUPPORTED");
        expect(await world.start(OTHER_GAME)).toBe("NOT_A_REFUSAL");
        expect(await changesOf(browserDb)).toBe("drop");
    });
});

test("a second game update after a recovery is a second drop, and only the drops tell followers", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb, browserDb }) => {
        const rng = createSeededRng(11_105);
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, rng, products);
        const alice = await follower(browserDb, rng, {
            email: "alice@lucent.test",
            follows: true,
            mail: false,
        });
        const tell = () => tellFollowers(browserDb, { catalog: products, mail: true });
        const later = { ...GAME, timeDateStamp: GAME.timeDateStamp + 2 };

        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");
        expect(await tell()).toEqual({ ok: true, value: { told: 1, givenUp: [] } });
        await world.support(UPDATED);
        expect(await tell()).toEqual({ ok: true, value: { told: 0, givenUp: [] } });
        expect(await world.start(later)).toBe("GAME_BUILD_UNSUPPORTED");
        expect(await tell()).toEqual({ ok: true, value: { told: 1, givenUp: [] } });
        expect(await changesOf(browserDb)).toBe("drop rise drop");
        expect(await inboxOf(browserDb, alice)).toBe(2);
    });
});

// Inserting an inbox entry for an account listed here fails, as a broken row or a full disk
// would: what a batch wrote before it stays only if that batch committed.
async function refuseInboxFor(db: Db, ids: readonly AccountId[]) {
    for (const statement of [
        sql`create table refused_inbox (account_id text primary key)`,
        sql`create function refuse_inbox() returns trigger language plpgsql as $$
            begin
                if exists (select 1 from refused_inbox where account_id = new.account_id) then
                    raise exception 'refused';
                end if;
                return new;
            end $$`,
        sql`create trigger refuse_inbox before insert on inbox_entry
            for each row execute function refuse_inbox()`,
    ]) {
        expect((await execute(db, statement)).ok).toBe(true);
    }
    for (const id of ids) {
        await execute(db, sql`insert into refused_inbox (account_id) values (${id})`);
    }
}

test("followers are told ten to a transaction, so a failure keeps the batches before it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb, browserDb }) => {
        const rng = createSeededRng(11_106);
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, rng, products);
        const followers: AccountId[] = [];
        for (let n = 0; n < 12; n += 1) {
            followers.push(
                await follower(browserDb, rng, {
                    email: `f${n}@lucent.test`,
                    follows: true,
                    mail: false,
                }),
            );
        }
        followers.sort();
        const last = followers.at(-1);
        invariant(last !== undefined, "there are followers");
        await refuseInboxFor(browserDb, [last]);
        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");

        expect((await tellFollowers(browserDb, { catalog: products, mail: true })).ok).toBe(false);
        const told = await Promise.all(followers.map((id) => inboxOf(browserDb, id)));
        expect(told.filter((n) => n === 1)).toHaveLength(10);
    });
});

test("a drop that keeps failing is given up after five attempts, and the drops after it are told", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_107);
        const products = liveCatalog();
        const stuck = await follower(db, rng, {
            email: "stuck@lucent.test",
            follows: true,
            mail: false,
        });
        const waiting = await seedAccount(db, rng, "waiting@lucent.test");
        await execute(
            db,
            sql`insert into product_subscription (account_id, product_id)
                values (${waiting}, 'lucent-loader')`,
        );
        await refuseInboxFor(db, [stuck]);
        const first = await scalar(
            db,
            z.string(),
            sql`with added as (
                    insert into product_support_change (product_id, supported, changed_at)
                    values ('cs2', false, now()), ('lucent-loader', false, now())
                    returning id)
                select min(id)::text as value from added`,
        );
        const tell = () => tellFollowers(db, { catalog: products, mail: true });

        for (let attempt = 1; attempt < 5; attempt += 1) {
            expect((await tell()).ok).toBe(false);
        }
        const loaderInbox = () =>
            scalar(
                db,
                z.coerce.number(),
                sql`select count(*) as value from inbox_entry where account_id = ${waiting}`,
            );
        expect(await loaderInbox()).toBe(0);
        expect(await tell()).toEqual({ ok: true, value: { told: 1, givenUp: [first] } });
        expect(await loaderInbox()).toBe(1);
        expect(await tell()).toEqual({ ok: true, value: { told: 0, givenUp: [] } });
    });
});

test("a suspended follower is told nothing, by inbox or by mail", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb, browserDb }) => {
        const rng = createSeededRng(11_108);
        const products = liveCatalog();
        const world = await supportWorld(nativeDb, rng, products);
        const kept = await follower(browserDb, rng, {
            email: "kept@lucent.test",
            follows: true,
            mail: true,
        });
        const suspended = await follower(browserDb, rng, {
            email: "suspended@lucent.test",
            follows: true,
            mail: true,
        });
        await execute(
            browserDb,
            sql`update account set status = 'suspended' where id = ${suspended}`,
        );
        await world.support(GAME);
        expect(await world.start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await world.start(UPDATED)).toBe("GAME_BUILD_UNSUPPORTED");

        expect(await tellFollowers(browserDb, { catalog: products, mail: true })).toEqual({
            ok: true,
            value: { told: 1, givenUp: [] },
        });
        expect(await inboxOf(browserDb, kept)).toBe(1);
        expect(await inboxOf(browserDb, suspended)).toBe(0);
        expect(await mailTo(browserDb, "suspended@lucent.test")).toBe(0);
    });
});
