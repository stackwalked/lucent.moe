import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { type AccountId, newEntitlementId, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import type { Logger } from "../src/base/core/log.ts";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { exportOwnData } from "../src/members/community/export.ts";
import { listInbox } from "../src/members/notify/inbox.ts";
import {
    subscriptionEndingJob,
    tellEndingSubscriptions,
} from "../src/members/notify/subscription-ending.ts";
import { catalog } from "./authority-fixtures.ts";
import { member, NO_LOG } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const loader = ProductId.parse("lucent-loader");

// An entitlement to the loader (a live product, listed for everyone) ending `endsIn` from now.
async function entitle(
    db: Db,
    rng: SeededRng,
    accountId: AccountId,
    endsIn: string | null,
    status: "active" | "suspended" | "revoked" = "active",
): Promise<string> {
    const id = newEntitlementId(rng);
    const inserted = await execute(
        db,
        sql`insert into entitlement (id, account_id, status, valid_from, valid_until)
            values (${id}, ${accountId}, ${status}, now() - interval '30 days',
                    ${endsIn === null ? sql`null` : sql`now() + ${endsIn}::interval`})`,
    );
    invariant(inserted.ok, "entitlement inserts");
    const product = await execute(
        db,
        sql`insert into entitlement_product (entitlement_id, product_id, features, channels)
            values (${id}, ${loader}, '"*"'::jsonb, '{stable}')`,
    );
    invariant(product.ok, "entitlement product inserts");
    return id;
}

const tell = (db: Db, logger: Logger = NO_LOG) =>
    tellEndingSubscriptions(db, { catalog: products, logger });

const entries = async (db: Db, accountId: AccountId) => {
    const rows = await queryAll(
        db,
        z.object({ kind: z.string(), productId: z.string().nullable() }),
        sql`select kind, product_id as "productId" from inbox_entry where account_id = ${accountId}
            order by created_at, id`,
    );
    invariant(rows.ok, "entries read");
    return rows.value;
};

test("each mark tells once, however often the job runs and however many run it at once", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(32_001);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const id = await entitle(db, rng, alice.id, "6 days");
        // Two runners at once: one notice.
        const [first, second] = await Promise.all([tell(db), tell(db)]);
        expect((first.ok ? first.value.told : -1) + (second.ok ? second.value.told : -1)).toBe(1);
        expect(await entries(db, alice.id)).toEqual([
            { kind: "subscription_ending", productId: "lucent-loader" },
        ]);
        // Later runs, the same mark: nothing more.
        expect(await tell(db)).toEqual(ok({ told: 0, failed: 0 }));
        // The second mark, a day from the end.
        const moved = await execute(
            db,
            sql`update entitlement set valid_until = now() + interval '20 hours' where id = ${id}`,
        );
        invariant(moved.ok, "moved");
        // A new end date is told for the marks it has reached.
        const [third, fourth] = await Promise.all([tell(db), tell(db)]);
        expect((third.ok ? third.value.told : -1) + (fourth.ok ? fourth.value.told : -1)).toBe(1);
        expect(await entries(db, alice.id)).toHaveLength(2);
        expect(await tell(db)).toEqual(ok({ told: 0, failed: 0 }));
        expect(await entries(db, alice.id)).toHaveLength(2);
    });
});

test("an entitlement extended past a mark and reaching it again is told again for the new date", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(32_002);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const id = await entitle(db, rng, alice.id, "6 days");
        expect(await tell(db)).toEqual(ok({ told: 1, failed: 0 }));
        const extend = (interval: string) =>
            execute(
                db,
                sql`update entitlement set valid_until = now() + ${interval}::interval where id = ${id}`,
            );
        expect((await extend("40 days")).ok).toBe(true);
        expect(await tell(db)).toEqual(ok({ told: 0, failed: 0 }));
        expect((await extend("5 days")).ok).toBe(true);
        expect(await tell(db)).toEqual(ok({ told: 1, failed: 0 }));
        expect(await entries(db, alice.id)).toHaveLength(2);
    });
});

test("nothing for an entitlement with no end, one far off, ended, suspended or revoked, nor for a suspended or deleted account", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(32_003);
        const open = await member(db, rng, "open@lucent.test", "open");
        const far = await member(db, rng, "far@lucent.test", "far");
        const ended = await member(db, rng, "ended@lucent.test", "ended");
        const paused = await member(db, rng, "paused@lucent.test", "paused");
        const revoked = await member(db, rng, "revoked@lucent.test", "revoked");
        const barred = await member(db, rng, "barred@lucent.test", "barred");
        const gone = await member(db, rng, "gone@lucent.test");
        const told = await member(db, rng, "told@lucent.test", "told");
        await entitle(db, rng, open.id, null);
        await entitle(db, rng, far.id, "30 days");
        await entitle(db, rng, ended.id, "-1 hour");
        await entitle(db, rng, paused.id, "2 days", "suspended");
        await entitle(db, rng, revoked.id, "2 days", "revoked");
        await entitle(db, rng, barred.id, "2 days");
        await entitle(db, rng, gone.id, "2 days");
        await entitle(db, rng, told.id, "2 days");
        const standing = await execute(
            db,
            sql`update account set status = 'suspended' where id = ${barred.id}`,
        );
        invariant(standing.ok, "suspended");
        const tombstoned = await execute(
            db,
            sql`update account set email = null, deleted_at = now(),
                suspended_at_deletion = false where id = ${gone.id}`,
        );
        invariant(tombstoned.ok, "tombstoned");
        expect(await tell(db)).toEqual(ok({ told: 1, failed: 0 }));
        for (const quiet of [open, far, ended, paused, revoked, barred, gone]) {
            expect(await entries(db, quiet.id)).toEqual([]);
        }
        expect(await entries(db, told.id)).toHaveLength(1);
    });
});

test("the inbox names the product while the member may see it, and not once they may not", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(32_004);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const seed = ProductId.parse("cs2");
        const id = newEntitlementId(rng);
        for (const statement of [
            sql`insert into entitlement (id, account_id, valid_from, valid_until)
                values (${id}, ${alice.id}, now() - interval '30 days', now() + interval '2 days')`,
            sql`insert into entitlement_product (entitlement_id, product_id, features, channels)
                values (${id}, ${seed}, '"*"'::jsonb, '{stable}')`,
        ]) {
            expect((await execute(db, statement)).ok).toBe(true);
        }
        expect(await tell(db)).toEqual(ok({ told: 1, failed: 0 }));
        const read = async () => {
            const listed = await listInbox(db, alice.token, { catalog: products, cursor: null });
            invariant(listed.ok, "the inbox lists");
            return listed.value.items.map((item) => [item.kind, item.productId] as const);
        };
        expect(await read()).toEqual([["subscription_ending", seed]]);
        // The seed product is hidden from someone who holds nothing: the notice stays, unnamed.
        expect(
            (await execute(db, sql`update entitlement set status = 'revoked' where id = ${id}`)).ok,
        ).toBe(true);
        expect(await read()).toEqual([["subscription_ending", null]]);
    });
});

test("the member's export still reads with an ending-subscription notice in the inbox", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(32_005);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        await entitle(db, rng, alice.id, "2 days");
        expect(await tell(db)).toEqual(ok({ told: 1, failed: 0 }));
        const exported = await exportOwnData(db, alice.token);
        invariant(exported.ok, "the export reads");
        expect(exported.value.inbox.map((entry) => entry.kind)).toEqual(["subscription_ending"]);
    });
});

test("a member who renewed early is not told their subscription ends, and is when the renewal itself nears its end", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(32_006);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        await entitle(db, rng, alice.id, "20 hours");
        const later = await entitle(db, rng, alice.id, "60 days");
        // Both marks of the earlier one have been reached: nothing, since access continues.
        expect(await tell(db)).toEqual(ok({ told: 0, failed: 0 }));
        expect(await entries(db, alice.id)).toEqual([]);
        // The renewal itself nears its end: told once, for it alone.
        const moved = await execute(
            db,
            sql`update entitlement set valid_until = now() + interval '6 days' where id = ${later}`,
        );
        invariant(moved.ok, "moved");
        // The earlier one now ends inside the renewal's term: still covered, still quiet.
        expect(await tell(db)).toEqual(ok({ told: 1, failed: 0 }));
        expect(await entries(db, alice.id)).toHaveLength(1);
        // An entitlement with no end covers too.
        const open = await member(db, rng, "open@lucent.test", "open");
        await entitle(db, rng, open.id, "2 days");
        await entitle(db, rng, open.id, null);
        expect(await tell(db)).toEqual(ok({ told: 0, failed: 0 }));
        expect(await entries(db, open.id)).toEqual([]);
    });
});

test("a failing entitlement is logged with its id and does not stop the ones after it; the run reports it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(32_007);
        const broken = await member(db, rng, "broken@lucent.test", "broken");
        const fine = await member(db, rng, "fine@lucent.test", "fine");
        // The broken one ends first, so it is tried first.
        const brokenId = await entitle(db, rng, broken.id, "2 days");
        await entitle(db, rng, fine.id, "5 days");
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
            sql`insert into refused_inbox (account_id) values (${broken.id})`,
        ]) {
            expect((await execute(db, statement)).ok).toBe(true);
        }
        const lines: string[] = [];
        const logger: Logger = {
            write: (_level, _msg, fields) => lines.push(fields?.detail ?? ""),
        };
        expect(await tell(db, logger)).toEqual(ok({ told: 1, failed: 1 }));
        expect(await entries(db, fine.id)).toHaveLength(1);
        expect(await entries(db, broken.id)).toEqual([]);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(brokenId);
        // The job reports the run as failed, so the staff jobs page shows it.
        const job = subscriptionEndingJob({ db, catalog: products, logger });
        expect(await job.run()).toEqual(err({ code: "ENTITLEMENT_NOTICE_FAILED" }));
    });
});

test("the soonest ending is told first when more are due than one run takes", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(32_008);
        // An account id that sorts first has the later end: ordering by account would tell it first.
        const members = [
            await member(db, rng, "a@lucent.test", "ma"),
            await member(db, rng, "b@lucent.test", "mb"),
        ].sort((x, y) => (x.id < y.id ? -1 : 1));
        const [low, high] = members;
        invariant(low !== undefined && high !== undefined, "two members");
        await entitle(db, rng, low.id, "6 days");
        await entitle(db, rng, high.id, "1 hour");
        expect(await tell(db)).toEqual(ok({ told: 2, failed: 0 }));
        const rows = await queryAll(
            db,
            z.object({ accountId: z.string() }),
            sql`select account_id as "accountId" from inbox_entry order by created_at, id`,
        );
        invariant(rows.ok, "rows read");
        expect(rows.value.map((row) => row.accountId)).toEqual([high.id, low.id]);
    });
});
