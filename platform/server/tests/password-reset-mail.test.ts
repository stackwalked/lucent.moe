import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { z } from "zod";
import { createMailTransport } from "../src/adapters/mail/mail.ts";
import { requestPasswordReset } from "../src/auth/password-reset.ts";
import { execute, queryOne, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { claimMail, settleMail } from "../src/notify/mail.ts";
import { newMember } from "./auth-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

test("a dead reset mail outlives its link as a dead row without address, text or link", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(8204);
        const deps = await createTestAuthDeps(db, rng);
        await newMember(deps, rng, { username: "alice", with: "all" });
        expect(await requestPasswordReset(deps, "alice@lucent.test")).toEqual(ok(undefined));
        const worker = { db, mail: await createMailTransport({ provider: "log" }) };
        const claim = await claimMail(worker);
        invariant(claim.ok && claim.value !== null, "the reset mail is due");
        expect(await settleMail(worker, claim.value, "refused")).toEqual(ok(undefined));
        expect((await execute(db, sql`delete from password_reset`)).ok).toBe(true);
        expect(
            await queryOne(
                db,
                z.object({
                    kind: z.string(),
                    state: z.string(),
                    erased: z.boolean(),
                    finished: z.boolean(),
                }),
                sql`select kind, state, finished_at is not null as finished,
                (recipient is null and subject is null and body is null and reset_hash is null) as erased
                from mail_outbox`,
            ),
        ).toEqual(ok({ kind: "reset", state: "dead", erased: true, finished: true }));
    });
});

test("a reset mail still waiting goes with its link", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(8205);
        const deps = await createTestAuthDeps(db, rng);
        await newMember(deps, rng, { username: "alice", with: "all" });
        expect(await requestPasswordReset(deps, "alice@lucent.test")).toEqual(ok(undefined));
        expect((await execute(db, sql`delete from password_reset`)).ok).toBe(true);
        expect(
            await queryOne(
                db,
                z.object({ rows: z.coerce.number() }),
                sql`select count(*) as rows from mail_outbox`,
            ),
        ).toEqual(ok({ rows: 0 }));
    });
});

test("with no mail provider a reset request answers alike and stores no link and no mail", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(8206);
        const deps = { ...(await createTestAuthDeps(db, rng)), mailEnabled: false };
        await newMember(deps, rng, { username: "alice", with: "all" });
        for (const email of ["alice@lucent.test", "missing@lucent.test"])
            expect(await requestPasswordReset(deps, email)).toEqual(ok(undefined));
        expect(
            await queryOne(
                db,
                z.object({ links: z.coerce.number(), mails: z.coerce.number() }),
                sql`select (select count(*) from password_reset) as links, (select count(*) from mail_outbox) as mails`,
            ),
        ).toEqual(ok({ links: 0, mails: 0 }));
    });
});

test("a reset request for an account whose row is locked waits for the lock and still queues its mail", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(8207);
        const deps = await createTestAuthDeps(db, rng);
        const member = await newMember(deps, rng, { username: "alice", with: "all" });
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = () => {};
        const locked = new Promise<void>((resolve) => {
            held = resolve;
        });
        const holder = withTx(db, async (tx) => {
            const row = await execute(
                tx,
                sql`select id from account where id = ${member.accountId} for update`,
            );
            held();
            await gate;
            return row;
        });
        await locked;
        const request = requestPasswordReset(deps, "alice@lucent.test");
        // Release only once PostgreSQL reports the request waiting on the row lock.
        for (let i = 0; i < 400; i++) {
            const waiting = await queryOne(
                db,
                z.object({ n: z.coerce.number() }),
                sql`select count(*) as n from pg_stat_activity where wait_event_type = 'Lock'`,
            );
            if (waiting.ok && waiting.value !== null && waiting.value.n > 0) break;
            await Bun.sleep(5);
        }
        release();
        expect((await holder).ok).toBe(true);
        expect(await request).toEqual(ok(undefined));
        expect(
            await queryOne(
                db,
                z.object({ mails: z.coerce.number() }),
                sql`select count(*) as mails from mail_outbox where kind = 'reset' and state = 'pending'`,
            ),
        ).toEqual(ok({ mails: 1 }));
    });
});
