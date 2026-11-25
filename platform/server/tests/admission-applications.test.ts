import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { type AccountId, BearerToken, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { createMailTransport } from "../src/adapters/mail/mail.ts";
import {
    type ApplicationInput,
    approveApplication,
    declineApplication,
    listApplications,
    listOfferedProducts,
    readApplication,
    submitApplication,
} from "../src/admission/applications.ts";
import type { AuthDeps } from "../src/auth/deps.ts";
import { redeemSetupLink } from "../src/auth/setup.ts";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { claimMail, sendClaim, settleMail } from "../src/notify/mail.ts";
import { seedRootOnce } from "./auth-fixtures.ts";
import {
    catalog,
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

const LOADER = ProductId.parse("lucent-loader");

const form = (email: string): ApplicationInput => ({
    email,
    products: [LOADER],
    about: "i play a lot.\n<b>not markup</b>",
    discord: "someone",
    knownBy: "@Founder",
});

const submit = (world: World, input: ApplicationInput) =>
    submitApplication(world.deps, { catalog: catalog(), input });

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
            products: [LOADER],
            about: "i play a lot.\n<b>not markup</b>",
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
        expect(approved.value.setupToken).toBeNull();

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
    "only live products are offered, and a seed product cannot be asked for",
    inWorld(9203, async (world) => {
        expect(listOfferedProducts(catalog()).map((p) => p.productId)).toEqual([LOADER]);
        expect(
            await submit(world, {
                ...form("seed@lucent.test"),
                products: [ProductId.parse("cs2")],
            }),
        ).toEqual(err({ code: "PRODUCT_NOT_OFFERED" }));
        expect(await count(world.db, sql`select count(*) as value from application`)).toBe(0);
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
    "approving an address that got an account meanwhile is refused, and without a provider the link comes back to staff",
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
        const approved = await approveApplication(
            { ...world.deps, mailEnabled: false },
            { caller: staff, applicationId: fay.applicationId },
        );
        expect(approved.ok && approved.value.setupToken !== null).toBe(true);
        expect(await count(world.db, sql`select count(*) as value from mail_outbox`)).toBe(0);
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
