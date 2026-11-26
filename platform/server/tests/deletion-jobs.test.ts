import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import type { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import type { Logger } from "../src/base/core/log.ts";
import { type Db, execute, type SqlFragment, sql, toTimestamptz } from "../src/base/db/pool.ts";
import { deletionJob } from "../src/base/jobs/deletion.ts";
import { RETENTION, sweepRetention } from "../src/base/jobs/retention.ts";
import type { AuthDeps } from "../src/identity/auth/deps.ts";
import { requestDeletion } from "../src/identity/deletion/deletion.ts";
import { listDueDeletions } from "../src/identity/deletion/strip.ts";
import { type Member, newMember, seedRootOnce } from "./auth-fixtures.ts";
import { dbNow, grantRole, scalar, seedRole } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const count = (db: Db, statement: SqlFragment) => scalar(db, z.coerce.number(), statement);

function recordingLogger(): Logger & { readonly lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        write: (level, msg, fields) => lines.push(`${level} ${msg} ${fields?.detail}`),
    };
}

async function asked(deps: AuthDeps, member: Member) {
    const done = await requestDeletion(deps, {
        token: member.sessionToken,
        purpose: "member",
        client: null,
    });
    invariant(done.ok, "requesting failed");
}

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

        const job = deletionJob({ ...deps, logger: recordingLogger() });
        expect(await job.run()).toEqual(ok("completed 1 deletions, 0 failed, 0 held by a role"));
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
        expect((await deletionJob({ ...deps, logger: recordingLogger() }).run()).ok).toBe(true);

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

test("one account that fails is named and passed over, and the rest are deleted", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(1403);
        const deps = await createTestAuthDeps(db, rng);
        await seedRootOnce(db, rng);
        const bad = await newMember(deps, rng, { username: "bad", with: "passkey" });
        const good = await newMember(deps, rng, { username: "good", with: "passkey" });
        for (const member of [bad, good]) await asked(deps, member);
        await lapse(db, bad.accountId);
        await lapse(db, good.accountId);
        // The failing one is due first, so it heads the batch.
        await execute(
            db,
            sql`update account set deletion_due_at = deletion_due_at - interval '1 hour'
                where id = ${bad.accountId}`,
        );
        // Stripping this one account fails: a trigger refuses deleting its passkeys.
        for (const statement of [
            sql`create table refuse_probe_account (id text primary key)`,
            sql`insert into refuse_probe_account (id) values (${bad.accountId})`,
            sql`create function refuse_probe() returns trigger language plpgsql as $$
                begin
                    if exists (select 1 from refuse_probe_account where id = old.account_id) then
                        raise exception 'probe' using errcode = 'check_violation';
                    end if;
                    return old;
                end; $$`,
            sql`create trigger refuse_probe_trg before delete on passkey
                for each row execute function refuse_probe()`,
        ]) {
            expect((await execute(db, statement)).ok).toBe(true);
        }
        const logger = recordingLogger();
        expect(await deletionJob({ ...deps, logger }).run()).toEqual(
            ok("completed 1 deletions, 1 failed, 0 held by a role"),
        );
        expect(logger.lines).toEqual([`warn deletions failed ${bad.accountId} CHECK_VIOLATION`]);
        expect(
            await count(
                db,
                sql`select count(*) as value from account
                    where deleted_at is not null and id = ${good.accountId}`,
            ),
        ).toBe(1);
    });
});

test("an account held by a role is counted, never listed, so it can't fill the batch", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(1404);
        const deps = await createTestAuthDeps(db, rng);
        await seedRootOnce(db, rng);
        const held = await newMember(deps, rng, { username: "held", with: "passkey" });
        const free = await newMember(deps, rng, { username: "free", with: "passkey" });
        for (const member of [held, free]) await asked(deps, member);
        await lapse(db, held.accountId);
        await lapse(db, free.accountId);
        await execute(
            db,
            sql`update account set deletion_due_at = deletion_due_at - interval '1 hour'
                where id = ${held.accountId}`,
        );
        const roleId = await seedRole(db, { id: "role_quiet", rank: 0, permissions: [] });
        await grantRole(db, { accountId: held.accountId, roleId });

        expect(await listDueDeletions(db, 1)).toEqual(ok({ due: [free.accountId], held: 1 }));
    });
});

test("a ticket's subject stays while any of its owner's messages remain", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(1405);
        const deps = await createTestAuthDeps(db, rng);
        await seedRootOnce(db, rng);
        const hal = await newMember(deps, rng, { username: "hal", with: "passkey" });
        await execute(
            db,
            sql`with t as (
                    insert into ticket (account_id, kind, subject, state, opened_at, last_activity_at)
                    values (${hal.accountId}, 'help', 'kept subject', 'open', now(), now())
                    returning id)
                insert into ticket_message (ticket_id, author_id, from_staff, body, created_at)
                select t.id, ${hal.accountId}, false, 'still here', now() from t`,
        );
        await asked(deps, hal);
        await lapse(db, hal.accountId);
        expect((await deletionJob({ ...deps, logger: recordingLogger() }).run()).ok).toBe(true);
        await execute(
            db,
            sql`update account set deleted_at = now() - interval '31 days' where id = ${hal.accountId}`,
        );
        // The subject's sweep alone, as a run whose message sweep stopped at its batch would leave it.
        const subjects = RETENTION.find(
            (entry) => entry.what === "ticket subject, a deleted account's",
        );
        invariant(subjects?.sweep !== undefined, "the subject sweep is listed");
        expect(await execute(db, subjects.sweep(toTimestamptz(await dbNow(db))))).toEqual(ok(0));
        expect(
            await count(
                db,
                sql`select count(*) as value from ticket where subject = 'kept subject'`,
            ),
        ).toBe(1);
    });
});
