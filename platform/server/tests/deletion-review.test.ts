import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { type AccountId, ChannelId, newOperationId, RoleId } from "@lucent/core/scalars";
import { z } from "zod";
import { setInviteAllowance } from "../src/admission/invites.ts";
import type { AuthDeps } from "../src/auth/deps.ts";
import { resolveViewer } from "../src/auth/viewer.ts";
import {
    assignAccountRole,
    issueEntitlement,
    recoverAccount,
    reinstateAccount,
    renameAccount,
    suspendAccount,
    unassignAccountRole,
} from "../src/authority/writers.ts";
import { type Db, execute, queryOne, type SqlFragment, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { requestDeletion } from "../src/deletion/deletion.ts";
import { completeDeletion } from "../src/deletion/strip.ts";
import { readStaffTicket } from "../src/support/tickets.ts";
import { type Member, newMember, seedRootOnce } from "./auth-fixtures.ts";
import {
    catalog,
    dbNow,
    grantRole,
    product,
    scalar,
    seedRole,
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

const count = (db: Db, statement: SqlFragment) => scalar(db, z.coerce.number(), statement);

// The due date as the mail writes it, read back from PostgreSQL rather than computed the same way.
async function mailedDay(db: Db, at: number) {
    return await scalar(
        db,
        z.string(),
        sql`select extract(day from d)::int || ' ' || lower(trim(to_char(d, 'Month'))) || ' '
                   || extract(year from d)::int as value
            from (select to_timestamp(${at} / 1000.0) at time zone 'UTC' as d) x`,
    );
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

async function ask(deps: AuthDeps, member: Member) {
    const asked = await requestDeletion(deps, {
        token: member.sessionToken,
        purpose: "member",
        client: null,
    });
    invariant(asked.ok, `requesting failed: ${JSON.stringify(asked)}`);
    return asked.value;
}

async function tombstone(world: World, username: string) {
    const member = await newMember(world.deps, world.rng, { username, with: "passkey" });
    await ask(world.deps, member);
    await lapse(world.db, member.accountId);
    const done = await completeDeletion(world.deps, member.accountId);
    invariant(done.ok, `completing failed: ${JSON.stringify(done)}`);
    return member.accountId;
}

const codeOf = (result: Result<unknown, { readonly code: string }>) =>
    result.ok ? "ok" : result.error.code;

test(
    "every staff writer refuses a deleted account as not found, and writes nothing",
    inWorld(1601, async (world) => {
        const { db, rng } = world;
        const staff = await steppedUp(db, world.rootId);
        const id = await tombstone(world, "gone");
        const roleId = await seedRole(db, { id: "role_helper", rank: 1, permissions: [] });
        const writes = sql`select
                (select count(*) from entitlement where account_id = ${id})
              + (select count(*) from account_role where account_id = ${id})
              + (select count(*) from setup_token where account_id = ${id})
              + (select count(*) from invite_allowance where account_id = ${id})
              + (select count(*) from username_claim where account_id = ${id})
              + (select count(*) from audit where target ->> 'accountId' = ${id}) as value`;
        const before = await count(db, writes);
        const state = sql`select status || ' ' || suspended_at_deletion::text as value
            from account where id = ${id}`;
        expect(await scalar(db, z.string(), state)).toBe("active false");

        const target = { db, caller: staff, targetAccountId: id };
        const refused = {
            issue: codeOf(
                await issueEntitlement({
                    ...target,
                    rng,
                    catalog: catalog(),
                    operationId: newOperationId(rng),
                    validFrom: await dbNow(db),
                    validUntil: null,
                    products: [
                        {
                            productId: product("cs2").id,
                            features: "*",
                            channels: [ChannelId.parse("stable")],
                        },
                    ],
                }),
            ),
            assign: codeOf(await assignAccountRole({ ...target, roleId, expiresAt: null })),
            unassign: codeOf(await unassignAccountRole({ ...target, roleId })),
            suspend: codeOf(
                await suspendAccount({ ...target, operationId: newOperationId(rng), reason: "x" }),
            ),
            reinstate: codeOf(
                await reinstateAccount({ ...target, operationId: newOperationId(rng) }),
            ),
            rename: codeOf(
                await renameAccount({
                    ...target,
                    operationId: newOperationId(rng),
                    username: "reborn",
                }),
            ),
            recover: codeOf(await recoverAccount({ ...target, rng })),
            allowance: codeOf(
                await setInviteAllowance(db, { caller: staff, accountId: id, granted: 1 }),
            ),
        };
        expect(refused).toEqual({
            issue: "NOT_FOUND",
            assign: "NOT_FOUND",
            unassign: "NOT_FOUND",
            suspend: "NOT_FOUND",
            reinstate: "NOT_FOUND",
            rename: "NOT_FOUND",
            recover: "NOT_FOUND",
            allowance: "NOT_FOUND",
        });
        expect(await count(db, writes)).toBe(before);
        expect(await scalar(db, z.string(), state)).toBe("active false");
    }),
);

test(
    "a role that carries nothing still holds a deletion",
    inWorld(1602, async ({ deps, db, rng }) => {
        const ned = await newMember(deps, rng, { username: "ned", with: "passkey" });
        const roleId = await seedRole(db, { id: "role_badge", rank: 0, permissions: [] });
        await grantRole(db, { accountId: ned.accountId, roleId });
        expect(
            await requestDeletion(deps, {
                token: ned.sessionToken,
                purpose: "member",
                client: null,
            }),
        ).toEqual(err({ code: "STAFF_CANNOT_DELETE" }));
        // Granted after the request, it holds the completion.
        await execute(db, sql`delete from account_role where account_id = ${ned.accountId}`);
        await ask(deps, ned);
        await lapse(db, ned.accountId);
        await grantRole(db, { accountId: ned.accountId, roleId: RoleId.parse("role_badge") });
        expect(await completeDeletion(deps, ned.accountId)).toEqual(
            err({ code: "STAFF_CANNOT_DELETE" }),
        );
    }),
);

test(
    "a request mails the date and the way back, and every page shows it pending",
    inWorld(1603, async ({ deps, db, rng }) => {
        const oli = await newMember(deps, rng, { username: "oli", with: "passkey" });
        const { dueAt } = await ask(deps, oli);
        const mails = await queryOne(
            db,
            z.object({ n: z.coerce.number(), subject: z.string(), body: z.string() }),
            sql`select count(*) over () as n, subject, body from mail_outbox
                where recipient = 'oli@lucent.test'`,
        );
        const day = await mailedDay(db, dueAt);
        expect(mails).toEqual(
            ok({
                n: 1,
                subject: "your lucent account will be deleted",
                body: `your account will be deleted on ${day}.\n\nto keep it, sign in before then and choose keep my account:\n\n${deps.rp.origin}/account/privacy`,
            }),
        );
        expect(
            await count(
                db,
                sql`select count(*) as value from inbox_entry
                    where account_id = ${oli.accountId} and kind = 'security'`,
            ),
        ).toBe(1);
        const viewer = await resolveViewer(db, { sessionToken: oli.sessionToken, client: null });
        expect(viewer.ok && viewer.value.deletionDueAt).toBe(dueAt);
    }),
);

test(
    "a comment on the member's guide racing the strip waits for it rather than failing it",
    inWorld(1604, async ({ deps, db, rng }) => {
        const pam = await newMember(deps, rng, { username: "pam", with: "passkey" });
        const rex = await newMember(deps, rng, { username: "rex", with: "passkey" });
        await execute(
            db,
            sql`insert into guide (product_id, author_id, title, body)
                values ('lucent-loader', ${pam.accountId}, 'pam guide', 'body')`,
        );
        await ask(deps, pam);
        await lapse(db, pam.accountId);
        // Rex's comment is written and held open: its insert holds a key share on the guide.
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const commenting = withTx(db, async (tx) => {
            const wrote = await execute(
                tx,
                sql`insert into comment (guide_id, author_id, body)
                    select id, ${rex.accountId}, 'racing comment' from guide
                    where author_id = ${pam.accountId}`,
            );
            invariant(wrote.ok, "the racing comment inserts");
            await held;
            return ok(undefined);
        });
        await waitForLockWaiters(db, 0);
        const completing = completeDeletion(deps, pam.accountId);
        expect(await waitForLockWaiters(db, 1)).toBe(true);
        release();
        expect((await commenting).ok).toBe(true);
        expect((await completing).ok).toBe(true);
        expect(
            await count(
                db,
                sql`select count(*) as value from comment where body = 'racing comment'`,
            ),
        ).toBe(0);
    }),
);

test(
    "a report filed while the strip runs is closed with the content it names",
    inWorld(1605, async ({ deps, db, rng }) => {
        const sid = await newMember(deps, rng, { username: "sid", with: "passkey" });
        const tim = await newMember(deps, rng, { username: "tim", with: "passkey" });
        await execute(
            db,
            sql`insert into shout (author_id, body) values (${sid.accountId}, 'loud')`,
        );
        await ask(deps, sid);
        await lapse(db, sid.accountId);
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        // As createReport does: the target share-locked, then the report written.
        const reporting = withTx(db, async (tx) => {
            const found = await execute(
                tx,
                sql`select 1 from shout where author_id = ${sid.accountId} for share`,
            );
            invariant(found.ok && found.value === 1, "the shout is there to report");
            const filed = await execute(
                tx,
                sql`insert into report (reporter_id, target_kind, target_id, reason)
                    select ${tim.accountId}, 'shout', id, 'spam' from shout
                    where author_id = ${sid.accountId}`,
            );
            invariant(filed.ok, "the report inserts");
            await held;
            return ok(undefined);
        });
        const completing = completeDeletion(deps, sid.accountId);
        expect(await waitForLockWaiters(db, 1)).toBe(true);
        release();
        expect((await reporting).ok).toBe(true);
        expect((await completing).ok).toBe(true);
        expect(
            await count(
                db,
                sql`select count(*) as value from report
                    where reporter_id = ${tim.accountId} and state = 'open'`,
            ),
        ).toBe(0);
    }),
);

test(
    "the member's open tickets close at completion and staff see the owner as deleted",
    inWorld(1606, async ({ deps, db, rng, rootId }) => {
        const uma = await newMember(deps, rng, { username: "uma", with: "passkey" });
        const ticket = await queryOne(
            db,
            z.object({ id: z.string() }),
            sql`insert into ticket (account_id, kind, subject, state, opened_at, last_activity_at)
                values (${uma.accountId}, 'help', 'help me', 'open', now(), now())
                returning id::text as id`,
        );
        invariant(ticket.ok && ticket.value !== null, "a ticket");
        await ask(deps, uma);
        await lapse(db, uma.accountId);
        expect((await completeDeletion(deps, uma.accountId)).ok).toBe(true);
        const read = await readStaffTicket(db, {
            caller: await steppedUp(db, rootId),
            ticketId: ticket.value.id,
        });
        expect(read.ok && [read.value.state, read.value.accountStatus]).toEqual([
            "closed",
            "deleted",
        ]);
    }),
);
