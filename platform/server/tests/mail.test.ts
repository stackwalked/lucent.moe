import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import type { Envelope, MailTransport } from "../src/base/adapters/mail/mail.ts";
import { type Db, execute, queryAll, queryOne, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { sweepRetention } from "../src/base/jobs/retention.ts";
import { listAudit } from "../src/identity/authority/reads.ts";
import { recordNotification } from "../src/members/notify/inbox.ts";
import { claimMail, mailDeliveryJob, sendClaim, settleMail } from "../src/members/notify/mail.ts";
import { dbNow, grantRole, seedAccount, seedRole, steppedUp } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

async function fixture(db: Db) {
    const recipient = await seedAccount(db, createSeededRng(5211), "private@lucent.test");
    let now = EpochMs.parse((await dbNow(db)) + 60_000);
    const clock = { now: () => now };
    const accepted = new Map<string, Envelope>();
    const requests: string[] = [];
    const mail: MailTransport = {
        provider: "brevo",
        binding: "fixture",
        send: (envelope) => {
            requests.push(envelope.id);
            const prior = accepted.get(envelope.id);
            if (prior === undefined) accepted.set(envelope.id, envelope);
            else expect(envelope).toEqual(prior);
            return Promise.resolve("accepted");
        },
    };
    const worker = { db, clock, mail };
    const notice = { kind: "security", productId: null } as const;
    return {
        worker,
        accepted,
        requests,
        recipient,
        notice,
        emit: () => withTx(db, (tx) => recordNotification(tx, { recipient, notice, mail: true })),
        advance: (ms: number) => {
            now = EpochMs.parse(now + ms);
        },
        claim: async () => {
            const claimed = await claimMail(worker);
            invariant(claimed.ok && claimed.value !== null, "expected a committed delivery");
            return claimed.value;
        },
    };
}

test("the mail drain cannot see an uncommitted event and rollback leaves nothing to send", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ nativeDb: db }) => {
        const f = await fixture(db);
        const result = await withTx(db, async (tx) => {
            expect(
                (
                    await recordNotification(tx, {
                        recipient: f.recipient,
                        notice: f.notice,
                        mail: true,
                    })
                ).ok,
            ).toBe(true);
            expect(await claimMail(f.worker)).toEqual(ok(null));
            return err({ code: "ABORT" });
        });
        expect(result).toEqual(err({ code: "ABORT" }));
        expect(await mailDeliveryJob(f.worker).run()).toEqual(ok(null));
        expect(f.requests).toEqual([]);
    });
});

test("with no provider a notice reaches the inbox and queues no mail", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ nativeDb: db }) => {
        const f = await fixture(db);
        expect(
            await withTx(db, (tx) =>
                recordNotification(tx, {
                    recipient: f.recipient,
                    notice: f.notice,
                    mail: false,
                }),
            ),
        ).toEqual(ok({ inbox: true, mail: false, discord: false }));
        expect(
            await queryOne(
                db,
                z.object({ mails: z.coerce.number(), entries: z.coerce.number() }),
                sql`select (select count(*) from mail_outbox) as mails, (select count(*) from inbox_entry) as entries`,
            ),
        ).toEqual(ok({ mails: 0, entries: 1 }));
    });
});

test("settled mail is kept 30 days when accepted and 90 when dead, then pruned", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ nativeDb: db }) => {
        for (const [state, days] of [
            ["accepted", 29],
            ["accepted", 31],
            ["dead", 89],
            ["dead", 91],
        ] as const)
            expect(
                (
                    await execute(
                        db,
                        sql`insert into mail_outbox(state, due_at, finished_at)
                        values (${state}, null, now() - ${days} * interval '1 day')`,
                    )
                ).ok,
            ).toBe(true);
        expect(await sweepRetention(db)).toEqual(ok(2));
        expect(
            await queryAll(
                db,
                z.object({ state: z.string(), days: z.coerce.number() }),
                sql`select state, round(extract(epoch from now() - finished_at) / 86400) as days
                from mail_outbox order by state, days`,
            ),
        ).toEqual(
            ok([
                { state: "accepted", days: 29 },
                { state: "dead", days: 89 },
            ]),
        );
    });
});

test.each(["before send", "after acceptance"] as const)(
    "restarting %s replays the identical envelope and fences the abandoned worker",
    async (crash) => {
        await (await sharedTestCluster()).withTestDb(async ({ nativeDb: db }) => {
            const f = await fixture(db);
            expect((await f.emit()).ok).toBe(true);
            const abandoned = await f.claim();
            expect(await claimMail(f.worker)).toEqual(ok(null));
            if (crash === "after acceptance")
                expect(await sendClaim(f.worker, abandoned)).toBe("accepted");
            f.advance(30_000);
            const recovered = await f.claim();
            expect(recovered.envelope).toEqual(abandoned.envelope);
            expect(await settleMail(f.worker, abandoned, "refused")).toEqual(ok(undefined));
            expect(await sendClaim(f.worker, abandoned)).toBe("retry");
            expect(await sendClaim(f.worker, recovered)).toBe("accepted");
            expect(await settleMail(f.worker, recovered, "accepted")).toEqual(ok(undefined));
            expect(f.requests).toHaveLength(crash === "before send" ? 1 : 2);
            expect(f.accepted.size).toBe(1);
            expect(
                await queryOne(
                    db,
                    z.object({ state: z.string(), erased: z.boolean() }),
                    sql`select state, (recipient is null and body is null and subject is null) as erased from mail_outbox`,
                ),
            ).toEqual(ok({ state: "accepted", erased: true }));
        });
    },
);

test.each(["expired key", "changed route"] as const)(
    "an uncertain attempt with %s becomes a redacted dead audit entry without a second send",
    async (reason) => {
        await (await sharedTestCluster()).withTestDb(async ({ nativeDb: db }) => {
            const f = await fixture(db);
            expect((await f.emit()).ok).toBe(true);
            const claim = await f.claim();
            expect(await sendClaim(f.worker, claim)).toBe("accepted");
            f.advance(reason === "expired key" ? 900_000 : 30_000);
            const worker =
                reason === "expired key"
                    ? f.worker
                    : { ...f.worker, mail: { ...f.worker.mail, binding: "another" } };
            expect(await claimMail(worker)).toEqual(ok(null));
            expect(await claimMail(worker)).toEqual(ok(null));
            expect(f.requests).toEqual([claim.envelope.id]);
            expect(
                await queryOne(
                    db,
                    z.object({ state: z.string(), erased: z.boolean() }),
                    sql`select state, (recipient is null and subject is null and body is null) as erased from mail_outbox`,
                ),
            ).toEqual(ok({ state: "dead", erased: true }));
            expect(
                await queryOne(
                    db,
                    z.object({ target: z.record(z.string(), z.unknown()), actor_id: z.string() }),
                    sql`select target, actor_id from audit where operation = 'mail.delivery_dead'`,
                ),
            ).toEqual(
                ok({
                    target: {
                        outcome: "unconfirmed",
                        deliveryId: await staffRef(db, claim.envelope.id),
                        attempts: 1,
                    },
                    actor_id: "job:mail",
                }),
            );
        });
    },
);

test("a retryable response backs off before using the same key again", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ nativeDb: db }) => {
        const f = await fixture(db);
        expect((await f.emit()).ok).toBe(true);
        const claim = await f.claim();
        expect(await settleMail(f.worker, claim, "retry")).toEqual(ok(undefined));
        f.advance(4_999);
        expect(await claimMail(f.worker)).toEqual(ok(null));
        f.advance(1);
        expect(await mailDeliveryJob(f.worker).run()).toEqual(ok("brevo: accepted"));
        expect(f.requests).toEqual([claim.envelope.id]);
    });
});

test("only an audit reader sees a dead letter, without an envelope or account identity", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ nativeDb: db }) => {
        const f = await fixture(db);
        expect((await f.emit()).ok).toBe(true);
        const claim = await f.claim();
        expect(await settleMail(f.worker, claim, "refused")).toEqual(ok(undefined));
        const params = {
            caller: await steppedUp(db, f.recipient),
            cursor: null,
            filter: {
                actorId: null,
                targetAccountId: null,
                operation: "mail.delivery_dead",
                before: null,
            },
        };
        expect(await listAudit(db, params)).toEqual(err({ code: "FORBIDDEN" }));
        const roleId = await seedRole(db, {
            id: "role_audit_reader",
            rank: 10,
            permissions: ["audit:read"],
        });
        await grantRole(db, { accountId: f.recipient, roleId });
        const page = await listAudit(db, params);
        invariant(page.ok, "audit reader sees the outbox terminal state");
        expect(page.value.items.map((row) => row.target)).toEqual([
            {
                accountId: null,
                username: null,
                detail: {
                    outcome: "refused",
                    deliveryId: await staffRef(db, claim.envelope.id),
                    attempts: 1,
                },
            },
        ]);
    });
});

async function staffRef(db: Db, id: string) {
    const row = await queryOne(
        db,
        z.object({ staff_ref: z.uuid() }),
        sql`select staff_ref from mail_outbox where id=${id}`,
    );
    invariant(row.ok && row.value !== null, "persisted staff reference");
    expect(row.value.staff_ref).not.toBe(id);
    return row.value.staff_ref;
}
