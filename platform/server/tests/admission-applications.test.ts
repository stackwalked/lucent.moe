import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { type AccountId, BearerToken } from "@lucent/core/scalars";
import { webContract } from "@lucent/rpc/web";
import { z } from "zod";
import { createMailTransport } from "../src/base/adapters/mail/mail.ts";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { sweepRetention } from "../src/base/jobs/retention.ts";
import {
    type ApplicationInput,
    approveApplication,
    declineApplication,
    listApplications,
    readApplication,
    submitApplication,
} from "../src/identity/admission/applications.ts";
import type { AuthDeps } from "../src/identity/auth/deps.ts";
import { redeemSetupLink } from "../src/identity/auth/setup.ts";
import { recoverAccount } from "../src/identity/authority/writers.ts";
import { claimMail, sendClaim, settleMail } from "../src/members/notify/mail.ts";
import { seedRootOnce } from "./auth-fixtures.ts";
import {
    scalar,
    seedAccount,
    seedRole,
    seedStaff,
    steppedUp,
    waitForLockWaiters,
} from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

type World = {
    readonly deps: AuthDeps;
    readonly db: Db;
    readonly rng: SeededRng;
    readonly rootId: AccountId;
};

function inWorld(seed: number, run: (world: World) => Promise<void>) {
    return async () => {
        await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
            const rng = createSeededRng(seed);
            const deps = await createTestAuthDeps(db, rng);
            await run({ deps, db, rng, rootId: await seedRootOnce(db, rng) });
        });
    };
}

const form = (email: string): ApplicationInput => ({
    email,
    discord: "someone",
    experience: "i play a lot.\n<b>not markup</b>",
    games: "cs2",
    knownBy: "@Founder",
    additional: "streams",
});

const ApplicationForm = webContract["waitlist.application.submit"].input;

const submit = (world: World, input: ApplicationInput) => submitApplication(world.deps, { input });

const count = (db: Db, statement: ReturnType<typeof sql>) =>
    scalar(db, z.coerce.number(), statement);

async function onlyPending(world: World) {
    const listed = await listApplications(world.db, {
        caller: await steppedUp(world.db, world.rootId),
        state: "pending",
    });
    invariant(listed.ok, "the queue reads");
    return listed.value.items;
}

// A reviewer who has never stepped up: the queue needs none.
async function reviewer(world: World) {
    const roleId = await seedRole(world.db, {
        id: "role_reviewer",
        rank: 10,
        permissions: ["applications:review"],
    });
    const accountId = await seedStaff(world.db, world.rng, {
        email: "reviewer@lucent.test",
        roleId,
    });
    return { accountId, stepUpAt: null, client: null };
}

test(
    "an applicant applies, staff approve, the setup mail goes through the log provider and the account exists",
    inWorld(9201, async (world) => {
        expect(await submit(world, form("Ann@Lucent.test"))).toEqual(ok(undefined));
        const [item] = await onlyPending(world);
        invariant(item !== undefined, "the application waits");
        const staff = await reviewer(world);
        const read = await readApplication(world.db, {
            caller: staff,
            applicationId: item.applicationId,
        });
        expect(read.ok && read.value).toMatchObject({
            email: "ann@lucent.test",
            games: "cs2",
            experience: "i play a lot.\n<b>not markup</b>",
            additional: "streams",
            discord: "someone",
            knownBy: "@Founder",
            knownByMember: { username: "founder" },
            state: "pending",
            emailHasAccount: false,
        });

        const approved = await approveApplication(world.deps, {
            caller: staff,
            applicationId: item.applicationId,
        });
        invariant(approved.ok, `approving failed: ${JSON.stringify(approved)}`);

        const worker = { db: world.db, mail: await createMailTransport({ provider: "log" }) };
        const claim = await claimMail(worker);
        invariant(claim.ok && claim.value !== null, "the setup mail is due");
        expect(claim.value.envelope.recipient).toBe("ann@lucent.test");
        const link = /\/setup\/([A-Za-z0-9_-]{43})/.exec(claim.value.envelope.body)?.[1];
        invariant(link !== undefined, "the mail carries the setup link");
        const outcome = await sendClaim(worker, claim.value);
        expect(outcome).toBe("accepted");
        expect(await settleMail(worker, claim.value, outcome)).toEqual(ok(undefined));

        const setup = await redeemSetupLink(world.deps, { setupToken: BearerToken.parse(link) });
        expect(setup.ok).toBe(true);
        expect(
            await count(
                world.db,
                sql`select count(*) as value from account
                    where id = ${approved.value.accountId} and email = 'ann@lucent.test'`,
            ),
        ).toBe(1);
        // No product access comes with it.
        expect(
            await count(
                world.db,
                sql`select count(*) as value from entitlement where account_id = ${approved.value.accountId}`,
            ),
        ).toBe(0);
        expect(
            await count(
                world.db,
                sql`select count(*) as value from audit where operation = 'account.create'
                    and target ->> 'via' = 'application'
                    and target ->> 'applicationId' = ${item.applicationId}`,
            ),
        ).toBe(1);
        expect(
            await approveApplication(world.deps, {
                caller: staff,
                applicationId: item.applicationId,
            }),
        ).toEqual(err({ code: "ALREADY_DECIDED" }));
    }),
);

test(
    "the form answers alike and on the same floor for a new address, one with an account and one with an application waiting",
    inWorld(9202, async (world) => {
        await seedAccount(world.db, world.rng, "member@lucent.test");
        expect(await submit(world, form("waiting@lucent.test"))).toEqual(ok(undefined));
        for (const email of ["fresh@lucent.test", "member@lucent.test", "waiting@lucent.test"]) {
            const started = performance.now();
            expect(await submit(world, form(email))).toEqual(ok(undefined));
            expect(performance.now() - started).toBeGreaterThanOrEqual(340);
        }
        expect((await onlyPending(world)).map((a) => a.email)).toEqual([
            "waiting@lucent.test",
            "fresh@lucent.test",
        ]);
        expect(await count(world.db, sql`select count(*) as value from mail_outbox`)).toBe(0);
    }),
);

test(
    "naming a member who exists, is suspended or does not exist answers alike and on the same floor",
    inWorld(9203, async (world) => {
        const away = await seedAccount(world.db, world.rng, "away@lucent.test");
        expect(
            await execute(
                world.db,
                sql`update account set username = 'away', status = 'suspended' where id = ${away}`,
            ),
        ).toEqual(ok(1));
        const named = ["@Founder", "away", "nobody-by-that-name"];
        for (const knownBy of named) {
            const started = performance.now();
            expect(
                await submit(world, {
                    ...form(`applicant-${knownBy.replace(/\W/g, "")}@lucent.test`),
                    knownBy,
                }),
            ).toEqual(ok(undefined));
            expect(performance.now() - started).toBeGreaterThanOrEqual(340);
        }
        expect((await onlyPending(world)).map((a) => a.knownBy)).toEqual(named);
    }),
);

test.each([
    ["a handle of one character", { discord: "x" }],
    ["a handle of 33 characters", { discord: "x".repeat(33) }],
    ["a handle over two lines", { discord: "some\none" }],
    ["no experience", { experience: "  " }],
    ["experience over 1,000 characters", { experience: "x".repeat(1001) }],
    ["no games", { games: "" }],
    ["games over 300 characters", { games: "x".repeat(301) }],
    ["additional info over 1,000 characters", { additional: "x".repeat(1001) }],
    ["an empty name for who vouches", { knownBy: "" }],
    ["a field the form does not have", { products: ["lucent-loader"] }],
])("the form refuses %s", (_, change) => {
    expect(ApplicationForm.safeParse({ ...form("a@lucent.test"), ...change }).success).toBe(false);
});

test("the form takes the limits themselves, and the optional answers left out", () => {
    const limits = {
        email: "a@lucent.test",
        discord: "x".repeat(32),
        experience: "x".repeat(1000),
        games: "x".repeat(300),
        knownBy: null,
        additional: "x".repeat(1000),
    };
    expect(ApplicationForm.safeParse(limits).success).toBe(true);
    expect(ApplicationForm.safeParse({ ...limits, discord: "xy", additional: null }).success).toBe(
        true,
    );
});

test(
    "an application made before the form keeps its old answers as additional info, and can still be decided",
    inWorld(9211, async (world) => {
        const staff = await reviewer(world);
        // As migration 0048 leaves a row of the old form.
        await execute(
            world.db,
            sql`insert into application (email, discord, experience, games, additional, created_at)
                values ('old@lucent.test', '', '', '', 'what they wrote', now())`,
        );
        const [old] = await onlyPending(world);
        invariant(old !== undefined, "the application waits");
        const read = await readApplication(world.db, {
            caller: staff,
            applicationId: old.applicationId,
        });
        expect(read.ok && read.value).toMatchObject({
            discord: "",
            experience: "",
            games: "",
            additional: "what they wrote",
        });
        expect(
            await declineApplication(world.db, { caller: staff, applicationId: old.applicationId }),
        ).toEqual(ok(undefined));
    }),
);

test(
    "a declined applicant is not queued again until the wait has passed",
    inWorld(9204, async (world) => {
        const staff = await reviewer(world);
        await submit(world, form("dan@lucent.test"));
        const [first] = await onlyPending(world);
        invariant(first !== undefined, "the application waits");
        expect(
            await declineApplication(world.db, {
                caller: staff,
                applicationId: first.applicationId,
            }),
        ).toEqual(ok(undefined));
        expect(
            await declineApplication(world.db, {
                caller: staff,
                applicationId: first.applicationId,
            }),
        ).toEqual(err({ code: "ALREADY_DECIDED" }));
        await submit(world, form("dan@lucent.test"));
        expect(await onlyPending(world)).toEqual([]);
        expect(
            await execute(
                world.db,
                sql`update application set decided_at = now() - interval '31 days'
                    where id = ${first.applicationId}::bigint`,
            ),
        ).toEqual(ok(1));
        await submit(world, form("dan@lucent.test"));
        expect((await onlyPending(world)).map((a) => a.email)).toEqual(["dan@lucent.test"]);
    }),
);

test(
    "approving an address that got an account meanwhile is refused, and without a provider nothing is approved",
    inWorld(9205, async (world) => {
        const staff = await reviewer(world);
        await submit(world, form("eve@lucent.test"));
        await submit(world, form("fay@lucent.test"));
        const [eve, fay] = await onlyPending(world);
        invariant(eve !== undefined && fay !== undefined, "both wait");
        await seedAccount(world.db, world.rng, "eve@lucent.test");
        expect(
            await approveApplication(world.deps, {
                caller: staff,
                applicationId: eve.applicationId,
            }),
        ).toEqual(err({ code: "EMAIL_TAKEN" }));
        // The link would otherwise come back to a reviewer who never stepped up, for an address
        // anyone can apply with: an account without what accounts:create asks.
        expect(
            await approveApplication(
                { ...world.deps, mailEnabled: false },
                { caller: staff, applicationId: fay.applicationId },
            ),
        ).toEqual(err({ code: "MAIL_DISABLED" }));
        expect(
            await count(
                world.db,
                sql`select (select count(*) from mail_outbox)
                         + (select count(*) from account where email = 'fay@lucent.test')
                         + (select count(*) from application where state <> 'pending') as value`,
            ),
        ).toBe(0);
        expect(
            await approveApplication(world.deps, { caller: staff, applicationId: "999" }),
        ).toEqual(err({ code: "NOT_FOUND" }));
    }),
);

test(
    "two staff approving one application at once create one account",
    inWorld(9206, async (world) => {
        const staff = await reviewer(world);
        const root = await steppedUp(world.db, world.rootId);
        await submit(world, form("gil@lucent.test"));
        const [gil] = await onlyPending(world);
        invariant(gil !== undefined, "the application waits");
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = () => {};
        const locked = new Promise<void>((resolve) => {
            held = resolve;
        });
        const holder = withTx(world.db, async (tx) => {
            const row = await execute(
                tx,
                sql`select id from application where id = ${gil.applicationId}::bigint for update`,
            );
            held();
            await gate;
            return row;
        });
        await locked;
        const racing = [staff, root].map((caller) =>
            approveApplication(world.deps, { caller, applicationId: gil.applicationId }),
        );
        const queued = await waitForLockWaiters(world.db, 2);
        release();
        await holder;
        const results = await Promise.all(racing);
        expect(queued).toBe(true);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results).toContainEqual(err({ code: "ALREADY_DECIDED" }));
        expect(
            await count(
                world.db,
                sql`select count(*) as value from account where email = 'gil@lucent.test'`,
            ),
        ).toBe(1);
    }),
);

test(
    "an account without applications:review reads and decides nothing",
    inWorld(9207, async (world) => {
        await submit(world, form("hal@lucent.test"));
        const nobody = await steppedUp(
            world.db,
            await seedAccount(world.db, world.rng, "nobody@lucent.test"),
        );
        expect(await listApplications(world.db, { caller: nobody, state: "pending" })).toEqual(
            err({ code: "FORBIDDEN" }),
        );
        const [hal] = await onlyPending(world);
        invariant(hal !== undefined, "the application waits");
        expect(
            await approveApplication(world.deps, {
                caller: nobody,
                applicationId: hal.applicationId,
            }),
        ).toEqual(err({ code: "FORBIDDEN" }));
        expect(
            await declineApplication(world.db, {
                caller: nobody,
                applicationId: hal.applicationId,
            }),
        ).toEqual(err({ code: "FORBIDDEN" }));
    }),
);

test(
    "approve racing decline makes exactly one decision",
    inWorld(9208, async (world) => {
        const staff = await reviewer(world);
        const root = await steppedUp(world.db, world.rootId);
        await submit(world, form("ida@lucent.test"));
        const [ida] = await onlyPending(world);
        invariant(ida !== undefined, "the application waits");
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = () => {};
        const locked = new Promise<void>((resolve) => {
            held = resolve;
        });
        const holder = withTx(world.db, async (tx) => {
            const row = await execute(
                tx,
                sql`select id from application where id = ${ida.applicationId}::bigint for update`,
            );
            held();
            await gate;
            return row;
        });
        await locked;
        const approving = approveApplication(world.deps, {
            caller: staff,
            applicationId: ida.applicationId,
        });
        const declining = declineApplication(world.db, {
            caller: root,
            applicationId: ida.applicationId,
        });
        const queued = await waitForLockWaiters(world.db, 2);
        release();
        await holder;
        const [approved, declined] = [await approving, await declining];
        expect(queued).toBe(true);
        expect([approved.ok, declined.ok].filter(Boolean)).toHaveLength(1);
        const state = await scalar(
            world.db,
            z.string(),
            sql`select state as value from application where id = ${ida.applicationId}::bigint`,
        );
        const accounts = await count(
            world.db,
            sql`select count(*) as value from account where email = 'ida@lucent.test'`,
        );
        if (approved.ok) {
            expect(declined).toEqual(err({ code: "ALREADY_DECIDED" }));
            expect([state, accounts]).toEqual(["approved", 1]);
        } else {
            expect(approved).toEqual(err({ code: "ALREADY_DECIDED" }));
            expect([state, accounts]).toEqual(["declined", 0]);
        }
    }),
);

test(
    "decided applications go after their retention, pending ones stay, and a swept decline can apply again",
    inWorld(9209, async (world) => {
        const staff = await reviewer(world);
        for (const email of ["jo@lucent.test", "kai@lucent.test", "lu@lucent.test"])
            await submit(world, form(email));
        const [jo, kai] = await onlyPending(world);
        invariant(jo !== undefined && kai !== undefined, "all wait");
        await declineApplication(world.db, { caller: staff, applicationId: jo.applicationId });
        const approved = await approveApplication(world.deps, {
            caller: staff,
            applicationId: kai.applicationId,
        });
        expect(approved.ok).toBe(true);
        const age = (id: string, days: number) =>
            execute(
                world.db,
                sql`update application set created_at = now() - make_interval(days => ${days + 1}),
                        decided_at = now() - make_interval(days => ${days})
                    where id = ${id}::bigint`,
            );
        // Just inside each tier: nothing goes.
        await age(jo.applicationId, 29);
        await age(kai.applicationId, 89);
        expect((await sweepRetention(world.db)).ok).toBe(true);
        expect(await count(world.db, sql`select count(*) as value from application`)).toBe(3);
        await age(jo.applicationId, 31);
        await age(kai.applicationId, 91);
        expect((await sweepRetention(world.db)).ok).toBe(true);
        expect(
            await queryAll(
                world.db,
                z.object({ email: z.string(), state: z.string() }),
                sql`select email, state from application order by id`,
            ),
        ).toEqual(ok([{ email: "lu@lucent.test", state: "pending" }]));
        await submit(world, form("jo@lucent.test"));
        expect((await onlyPending(world)).map((a) => a.email)).toEqual([
            "lu@lucent.test",
            "jo@lucent.test",
        ]);
    }),
);

test(
    "a queued setup mail goes with its link: used, replaced, or no longer valid",
    inWorld(9210, async (world) => {
        const staff = await reviewer(world);
        for (const email of ["mo@lucent.test", "ned@lucent.test", "ola@lucent.test"])
            await submit(world, form(email));
        const ids = (await onlyPending(world)).map((a) => a.applicationId);
        const accounts: AccountId[] = [];
        for (const applicationId of ids) {
            const approved = await approveApplication(world.deps, { caller: staff, applicationId });
            invariant(approved.ok, "approved");
            accounts.push(approved.value.accountId);
        }
        const mails = (email: string) =>
            count(
                world.db,
                sql`select count(*) as value from mail_outbox
                    where kind = 'setup' and recipient = ${email}`,
            );
        const body = await scalar(
            world.db,
            z.string(),
            sql`select body as value from mail_outbox where recipient = 'mo@lucent.test'`,
        );
        const link = /\/setup\/([A-Za-z0-9_-]{43})/.exec(body)?.[1];
        invariant(link !== undefined, "the mail carries the link");
        expect(
            (await redeemSetupLink(world.deps, { setupToken: BearerToken.parse(link) })).ok,
        ).toBe(true);
        expect(await mails("mo@lucent.test")).toBe(0);

        const [, ned, ola] = accounts;
        invariant(ned !== undefined && ola !== undefined, "three accounts");
        const recovered = await recoverAccount({
            db: world.db,
            rng: world.rng,
            caller: await steppedUp(world.db, world.rootId),
            targetAccountId: ned,
        });
        expect(recovered.ok).toBe(true);
        expect(await mails("ned@lucent.test")).toBe(0);

        expect(
            await execute(
                world.db,
                sql`update setup_token set created_at = now() - interval '4 days',
                        expires_at = now() - interval '1 second'
                    where account_id = ${ola}`,
            ),
        ).toEqual(ok(1));
        const worker = { db: world.db, mail: await createMailTransport({ provider: "log" }) };
        expect(await claimMail(worker)).toEqual(ok(null));
    }),
);
