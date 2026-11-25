import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import type { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, type SqlFragment, sql } from "../src/db/pool.ts";
import { requestDeletion } from "../src/deletion/deletion.ts";
import { deletionJob } from "../src/jobs/deletion.ts";
import { sweepRetention } from "../src/jobs/retention.ts";
import { newMember, seedRootOnce } from "./auth-fixtures.ts";
import { scalar } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const count = (db: Db, statement: SqlFragment) => scalar(db, z.coerce.number(), statement);

async function lapse(db: Db, accountId: AccountId) {
    const moved = await execute(
        db,
        sql`update account set deletion_requested_at = now() - interval '8 days',
                deletion_due_at = now() - interval '1 day'
            where id = ${accountId}`,
    );
    expect(moved).toEqual(ok(1));
}

test("the job completes the deletions that are due and leaves the rest waiting", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(1401);
        const deps = await createTestAuthDeps(db, rng);
        await seedRootOnce(db, rng);
        const due = await newMember(deps, rng, { username: "due", with: "passkey" });
        const waiting = await newMember(deps, rng, { username: "waiting", with: "passkey" });
        for (const member of [due, waiting]) {
            const asked = await requestDeletion(deps, {
                token: member.sessionToken,
                purpose: "member",
                client: null,
            });
            invariant(asked.ok, "requesting failed");
        }
        await lapse(db, due.accountId);

        const job = deletionJob(deps);
        expect(await job.run()).toEqual(ok("completed 1 deletions, 0 held by a role"));
        expect(await job.run()).toEqual(ok(null));
        expect(
            await count(
                db,
                sql`select count(*) as value from account
                    where deleted_at is not null and id = ${due.accountId}`,
            ),
        ).toBe(1);
        expect(
            await count(
                db,
                sql`select count(*) as value from account
                    where deletion_due_at is not null and id = ${waiting.accountId}`,
            ),
        ).toBe(1);
    });
});

test("a deleted member's own ticket messages and subjects go 30 days on, and staff replies stay", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(1402);
        const deps = await createTestAuthDeps(db, rng);
        const rootId = await seedRootOnce(db, rng);
        const gus = await newMember(deps, rng, { username: "gus", with: "passkey" });
        const seeded = await execute(
            db,
            sql`with t as (
                    insert into ticket (account_id, kind, subject, state, opened_at, last_activity_at)
                    values (${gus.accountId}, 'help', 'my loader subject', 'answered', now(), now())
                    returning id)
                insert into ticket_message (ticket_id, author_id, from_staff, body, created_at)
                select t.id, v.author, v.staff, v.body, now()
                from t, (values (${gus.accountId}, false, 'the member asked'),
                                (${rootId}, true, 'staff answered')) as v(author, staff, body)`,
        );
        expect(seeded).toEqual(ok(2));
        invariant(
            (
                await requestDeletion(deps, {
                    token: gus.sessionToken,
                    purpose: "member",
                    client: null,
                })
            ).ok,
            "requesting failed",
        );
        await lapse(db, gus.accountId);
        expect((await deletionJob(deps).run()).ok).toBe(true);

        const bodies = sql`select count(*) as value from ticket_message where body = 'the member asked'`;
        const subjects = sql`select count(*) as value from ticket where subject = 'my loader subject'`;
        // Kept while support may still need them.
        await sweepRetention(db);
        expect(await count(db, bodies)).toBe(1);
        expect(await count(db, subjects)).toBe(1);

        await execute(
            db,
            sql`update account set deleted_at = now() - interval '31 days' where id = ${gus.accountId}`,
        );
        expect((await sweepRetention(db)).ok).toBe(true);
        expect(await count(db, bodies)).toBe(0);
        expect(await count(db, subjects)).toBe(0);
        expect(
            await count(
                db,
                sql`select count(*) as value from ticket_message where body = 'staff answered'`,
            ),
        ).toBe(1);
        expect(
            await count(
                db,
                sql`select count(*) as value from ticket
                    where account_id = ${gus.accountId} and owner_text_removed_at is not null`,
            ),
        ).toBe(1);
    });
});
