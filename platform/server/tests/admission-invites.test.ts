import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { AccountId, BearerToken, newOperationId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import {
    createInvite,
    invitePath,
    listOwnInvites,
    readInviteStanding,
    readInviteTree,
    redeemInvite,
    revokeInvite,
    setInviteAllowance,
} from "../src/identity/admission/invites.ts";
import type { AuthDeps } from "../src/identity/auth/deps.ts";
import { redeemSetupLink } from "../src/identity/auth/setup.ts";
import { reinstateAccount, suspendAccount } from "../src/identity/authority/writers.ts";
import { memberSession, seedRootOnce } from "./auth-fixtures.ts";
import { scalar, seedAccount, steppedUp, waitForLockWaiters } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

// What any contender in a mixed race answers.
type Outcome = Result<unknown, { readonly code: string }>;

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

async function inviter(world: World, email: string, granted: number) {
    const accountId = await seedAccount(world.db, world.rng, email);
    if (granted > 0) {
        const set = await setInviteAllowance(world.db, {
            caller: await steppedUp(world.db, world.rootId),
            accountId,
            granted,
        });
        expect(set).toEqual(ok(undefined));
    }
    return { accountId, session: await memberSession(world.deps, accountId) };
}

async function issued(world: World, session: BearerToken) {
    const created = await createInvite(world.deps, session);
    invariant(created.ok, `creating an invite failed: ${JSON.stringify(created)}`);
    return created.value;
}

const count = (db: Db, statement: ReturnType<typeof sql>) =>
    scalar(db, z.coerce.number(), statement);

// The setup link the outbox holds for an address, as the mail carries it.
async function mailedSetupToken(db: Db, email: string): Promise<BearerToken> {
    const rows = await queryAll(
        db,
        z.object({ body: z.string() }),
        sql`select body from mail_outbox where kind = 'setup' and recipient = ${email}`,
    );
    invariant(rows.ok && rows.value.length === 1, `one setup mail for ${email}`);
    const match = /\/setup\/([A-Za-z0-9_-]{43})/.exec(rows.value[0]?.body ?? "");
    invariant(match?.[1] !== undefined, "the mail carries a setup link");
    return BearerToken.parse(match[1]);
}

test(
    "an invite from a member's allowance sets up an account, the tree shows the edge, and the invitee's suspension is a strike against the inviter",
    inWorld(9101, async (world) => {
        const alice = await inviter(world, "alice@lucent.test", 1);
        const invite = await issued(world, alice.session);
        expect(invitePath(invite.token)).toMatch(/^\/invite#[A-Za-z0-9_-]{43}$/);

        expect(
            await redeemInvite(world.deps, {
                token: invite.token,
                email: "Bob@Lucent.test",
                client: null,
            }),
        ).toEqual(ok(undefined));
        const setup = await redeemSetupLink(world.deps, {
            setupToken: await mailedSetupToken(world.db, "bob@lucent.test"),
        });
        expect(setup.ok && setup.value.needsUsername).toBe(true);

        const bobId = AccountId.parse(
            await scalar(
                world.db,
                z.string(),
                sql`select id as value from account where email = 'bob@lucent.test'`,
            ),
        );
        // An account and nothing else: no entitlement, no role.
        expect(
            await count(
                world.db,
                sql`select (select count(*) from entitlement where account_id = ${bobId})
                         + (select count(*) from account_role where account_id = ${bobId}) as value`,
            ),
        ).toBe(0);
        expect(
            await count(
                world.db,
                sql`select count(*) as value from audit where operation = 'account.create'
                    and target ->> 'accountId' = ${bobId} and target ->> 'via' = 'invite'
                    and target ->> 'invitedBy' = ${alice.accountId}`,
            ),
        ).toBe(1);

        const staff = await steppedUp(world.db, world.rootId);
        const tree = await readInviteTree(world.db, { caller: staff });
        invariant(tree.ok, "the tree reads");
        expect(tree.value.members.map((m) => [m.accountId, m.invitedBy])).toEqual([
            [alice.accountId, null],
            [bobId, alice.accountId],
        ]);

        const strikes = async () => {
            const standing = await readInviteStanding(world.db, {
                caller: await steppedUp(world.db, world.rootId),
                accountId: alice.accountId,
            });
            invariant(standing.ok, "the standing reads");
            return standing.value.strikes;
        };
        expect(await strikes()).toEqual({ ever: 0, now: 0 });
        const target = { db: world.db, caller: staff, targetAccountId: bobId };
        expect(
            (
                await suspendAccount({
                    ...target,
                    operationId: newOperationId(world.rng),
                    reason: "spam",
                })
            ).ok,
        ).toBe(true);
        expect(await strikes()).toEqual({ ever: 1, now: 1 });
        expect(
            (await reinstateAccount({ ...target, operationId: newOperationId(world.rng) })).ok,
        ).toBe(true);
        // Reinstating the invitee does not take the strike back.
        expect(await strikes()).toEqual({ ever: 1, now: 0 });
        const after = await readInviteTree(world.db, { caller: staff });
        expect(after.ok && after.value.members[0]?.strikes).toEqual({ ever: 1, now: 0 });
    }),
);

test(
    "a member's allowance starts at zero, and revoking or letting an invite expire returns it",
    inWorld(9102, async (world) => {
        const carol = await inviter(world, "carol@lucent.test", 0);
        expect(await createInvite(world.deps, carol.session)).toEqual(
            err({ code: "NO_ALLOWANCE" }),
        );
        const staff = await steppedUp(world.db, world.rootId);
        expect(
            await setInviteAllowance(world.db, {
                caller: staff,
                accountId: carol.accountId,
                granted: 2,
            }),
        ).toEqual(ok(undefined));
        const first = await issued(world, carol.session);
        const second = await issued(world, carol.session);
        expect(await createInvite(world.deps, carol.session)).toEqual(
            err({ code: "NO_ALLOWANCE" }),
        );
        // Staff can lower it to what is spent, not below.
        expect(
            await setInviteAllowance(world.db, {
                caller: staff,
                accountId: carol.accountId,
                granted: 1,
            }),
        ).toEqual(err({ code: "BELOW_SPENT" }));

        expect(await revokeInvite(world.db, carol.session, first.inviteId)).toEqual(ok(undefined));
        expect(
            await redeemInvite(world.deps, {
                token: first.token,
                email: "x@lucent.test",
                client: null,
            }),
        ).toEqual(err({ code: "INVITE_INVALID" }));
        const expired = await execute(
            world.db,
            sql`update invite set created_at = now() - interval '8 days',
                    expires_at = now() - interval '1 day'
                where id = ${second.inviteId}::bigint`,
        );
        expect(expired).toEqual(ok(1));
        const listed = await listOwnInvites(world.db, carol.session);
        expect(listed.ok && listed.value).toMatchObject({
            granted: 2,
            spent: 0,
            invites: [
                { inviteId: second.inviteId, state: "expired", invitee: null },
                { inviteId: first.inviteId, state: "revoked", invitee: null },
            ],
        });
        expect(
            await setInviteAllowance(world.db, {
                caller: staff,
                accountId: carol.accountId,
                granted: 0,
            }),
        ).toEqual(ok(undefined));
    }),
);

test(
    "an invite redeemed past its expiry, or revoked, or someone else's, does nothing",
    inWorld(9103, async (world) => {
        const dave = await inviter(world, "dave@lucent.test", 2);
        const erin = await inviter(world, "erin@lucent.test", 0);
        const invite = await issued(world, dave.session);
        expect(await revokeInvite(world.db, erin.session, invite.inviteId)).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        await execute(
            world.db,
            sql`update invite set created_at = now() - interval '7 days 1 second',
                    expires_at = now() - interval '1 second'
                where id = ${invite.inviteId}::bigint`,
        );
        expect(
            await redeemInvite(world.deps, {
                token: invite.token,
                email: "late@lucent.test",
                client: null,
            }),
        ).toEqual(err({ code: "INVITE_INVALID" }));
        expect(
            await count(
                world.db,
                sql`select count(*) as value from account where email = 'late@lucent.test'`,
            ),
        ).toBe(0);
        const used = await issued(world, dave.session);
        expect(
            await redeemInvite(world.deps, {
                token: used.token,
                email: "frank@lucent.test",
                client: null,
            }),
        ).toEqual(ok(undefined));
        expect(await revokeInvite(world.db, dave.session, used.inviteId)).toEqual(
            err({ code: "INVITE_USED" }),
        );
    }),
);

test(
    "redeeming for an address that has an account answers the same, creates nothing and leaves the invite unused",
    inWorld(9104, async (world) => {
        const gina = await inviter(world, "gina@lucent.test", 1);
        const invite = await issued(world, gina.session);
        const started = performance.now();
        expect(
            await redeemInvite(world.deps, {
                token: invite.token,
                email: "gina@lucent.test",
                client: null,
            }),
        ).toEqual(ok(undefined));
        expect(performance.now() - started).toBeGreaterThanOrEqual(340);
        expect(
            await count(
                world.db,
                sql`select (select count(*) from mail_outbox) + (select count(*) from account) as value`,
            ),
        ).toBe(2);
        const listed = await listOwnInvites(world.db, gina.session);
        expect(listed.ok && listed.value.invites[0]?.state).toBe("unused");
    }),
);

test(
    "without a mail provider an invite cannot be redeemed",
    inWorld(9105, async (world) => {
        const hana = await inviter(world, "hana@lucent.test", 1);
        const invite = await issued(world, hana.session);
        expect(
            await redeemInvite(
                { ...world.deps, mailEnabled: false },
                { token: invite.token, email: "new@lucent.test", client: null },
            ),
        ).toEqual(err({ code: "MAIL_DISABLED" }));
        const listed = await listOwnInvites(world.db, hana.session);
        expect(listed.ok && listed.value.invites[0]?.state).toBe("unused");
    }),
);

test(
    "a suspended inviter can't create invites and their outstanding ones stop working until they are reinstated",
    inWorld(9106, async (world) => {
        const ivan = await inviter(world, "ivan@lucent.test", 2);
        const invite = await issued(world, ivan.session);
        const staff = await steppedUp(world.db, world.rootId);
        const target = { db: world.db, caller: staff, targetAccountId: ivan.accountId };
        await suspendAccount({ ...target, operationId: newOperationId(world.rng), reason: "x" });
        expect(await createInvite(world.deps, ivan.session)).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
        expect(
            await redeemInvite(world.deps, {
                token: invite.token,
                email: "judy@lucent.test",
                client: null,
            }),
        ).toEqual(err({ code: "INVITE_INVALID" }));
        await reinstateAccount({ ...target, operationId: newOperationId(world.rng) });
        expect(
            await redeemInvite(world.deps, {
                token: invite.token,
                email: "judy@lucent.test",
                client: null,
            }),
        ).toEqual(ok(undefined));
    }),
);

// Holds the inviter's account row so every contender queues on it, then lets them all go.
async function raceOn<T>(
    world: World,
    accountId: AccountId,
    contenders: number,
    start: () => readonly Promise<T>[],
): Promise<T[]> {
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
            sql`select id from account where id = ${accountId} for update`,
        );
        held();
        await gate;
        return row;
    });
    await locked;
    const racing = start();
    const queued = await waitForLockWaiters(world.db, contenders);
    release();
    expect((await holder).ok).toBe(true);
    const results = await Promise.all(racing);
    expect(queued).toBe(true);
    return results;
}

test(
    "two redeems of one invite create one account",
    inWorld(9107, async (world) => {
        const kim = await inviter(world, "kim@lucent.test", 1);
        const invite = await issued(world, kim.session);
        const results = await raceOn(world, kim.accountId, 2, () =>
            ["leo@lucent.test", "max@lucent.test"].map((email) =>
                redeemInvite(world.deps, { token: invite.token, email, client: null }),
            ),
        );
        expect(results).toContainEqual(ok(undefined));
        expect(results).toContainEqual(err({ code: "INVITE_INVALID" }));
        expect(
            await count(
                world.db,
                sql`select count(*) as value from account
                    where email in ('leo@lucent.test', 'max@lucent.test')`,
            ),
        ).toBe(1);
    }),
);

test(
    "a redeem racing a revoke either creates the account or is refused, never both",
    inWorld(9108, async (world) => {
        const nia = await inviter(world, "nia@lucent.test", 1);
        const invite = await issued(world, nia.session);
        const [redeemed, revoked] = await raceOn<Outcome>(world, nia.accountId, 2, () => [
            redeemInvite(world.deps, {
                token: invite.token,
                email: "oli@lucent.test",
                client: null,
            }),
            revokeInvite(world.db, nia.session, invite.inviteId),
        ]);
        const created = await count(
            world.db,
            sql`select count(*) as value from account where email = 'oli@lucent.test'`,
        );
        if (created === 1) {
            expect(redeemed).toEqual(ok(undefined));
            expect(revoked).toEqual(err({ code: "INVITE_USED" }));
        } else {
            expect(redeemed).toEqual(err({ code: "INVITE_INVALID" }));
            expect(revoked).toEqual(ok(undefined));
        }
    }),
);

test(
    "staff without the account actions read no tree and grant no allowance",
    inWorld(9109, async (world) => {
        const pam = await inviter(world, "pam@lucent.test", 0);
        const nobody = await steppedUp(world.db, pam.accountId);
        expect(await readInviteTree(world.db, { caller: nobody })).toEqual(
            err({ code: "FORBIDDEN" }),
        );
        const other = await seedAccount(world.db, world.rng, "quinn@lucent.test");
        expect(
            await setInviteAllowance(world.db, { caller: nobody, accountId: other, granted: 1 }),
        ).toEqual(err({ code: "FORBIDDEN" }));
    }),
);

test(
    "an invite that names a taken address three times stops working and stays spent",
    inWorld(9110, async (world) => {
        const rae = await inviter(world, "rae@lucent.test", 1);
        const invite = await issued(world, rae.session);
        const redeem = (email: string) =>
            redeemInvite(world.deps, { token: invite.token, email, client: null });
        for (let probe = 1; probe <= 3; probe += 1) {
            expect(await redeem("rae@lucent.test")).toEqual(ok(undefined));
        }
        expect(await redeem("sam@lucent.test")).toEqual(err({ code: "INVITE_INVALID" }));
        expect(
            await count(
                world.db,
                sql`select count(*) as value from account where email = 'sam@lucent.test'`,
            ),
        ).toBe(0);
        // To the inviter it reads as used, like any invite that is gone, never as probed.
        const listed = await listOwnInvites(world.db, rae.session);
        expect(listed.ok && listed.value).toMatchObject({
            granted: 1,
            spent: 1,
            invites: [{ state: "used", invitee: null }],
        });
        expect(await revokeInvite(world.db, rae.session, invite.inviteId)).toEqual(
            err({ code: "INVITE_USED" }),
        );
        await execute(
            world.db,
            sql`update invite set created_at = now() - interval '8 days',
                    expires_at = now() - interval '1 day'
                where id = ${invite.inviteId}::bigint`,
        );
        const later = await listOwnInvites(world.db, rae.session);
        expect(later.ok && later.value.spent).toBe(1);
        expect(await createInvite(world.deps, rae.session)).toEqual(err({ code: "NO_ALLOWANCE" }));
    }),
);

test(
    "a redeem that waited on the inviter's lock while its invite expired is refused",
    inWorld(9111, async (world) => {
        const tia = await inviter(world, "tia@lucent.test", 1);
        const invite = await issued(world, tia.session);
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
                sql`select id from account where id = ${tia.accountId} for update`,
            );
            held();
            await gate;
            return row;
        });
        await locked;
        const redeeming = redeemInvite(world.deps, {
            token: invite.token,
            email: "uma@lucent.test",
            client: null,
        });
        const queued = await waitForLockWaiters(world.db, 1);
        // The redeem's transaction began before this; the invite expires while it is parked.
        const expired = await execute(
            world.db,
            sql`update invite set created_at = clock_timestamp() - interval '1 day',
                    expires_at = clock_timestamp()
                where id = ${invite.inviteId}::bigint`,
        );
        release();
        expect((await holder).ok).toBe(true);
        expect(queued).toBe(true);
        expect(expired).toEqual(ok(1));
        expect(await redeeming).toEqual(err({ code: "INVITE_INVALID" }));
        expect(
            await count(
                world.db,
                sql`select count(*) as value from account where email = 'uma@lucent.test'`,
            ),
        ).toBe(0);
    }),
);

test(
    "two invites created at once from the last unit of allowance: one is made",
    inWorld(9112, async (world) => {
        const vic = await inviter(world, "vic@lucent.test", 1);
        const results = await raceOn(world, vic.accountId, 2, () => [
            createInvite(world.deps, vic.session),
            createInvite(world.deps, vic.session),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results).toContainEqual(err({ code: "NO_ALLOWANCE" }));
    }),
);

test(
    "an invite created while staff lower the allowance never leaves it below what is spent",
    inWorld(9113, async (world) => {
        const wes = await inviter(world, "wes@lucent.test", 1);
        const staff = await steppedUp(world.db, world.rootId);
        const [created, lowered] = await raceOn<Outcome>(world, wes.accountId, 2, () => [
            createInvite(world.deps, wes.session),
            setInviteAllowance(world.db, { caller: staff, accountId: wes.accountId, granted: 0 }),
        ]);
        const listed = await listOwnInvites(world.db, wes.session);
        invariant(listed.ok, "the list reads");
        expect(listed.value.spent).toBeLessThanOrEqual(listed.value.granted);
        if (created?.ok === true) {
            expect(lowered).toEqual(err({ code: "BELOW_SPENT" }));
            expect([listed.value.granted, listed.value.spent]).toEqual([1, 1]);
        } else {
            expect(created).toEqual(err({ code: "NO_ALLOWANCE" }));
            expect(lowered).toEqual(ok(undefined));
            expect([listed.value.granted, listed.value.spent]).toEqual([0, 0]);
        }
    }),
);
