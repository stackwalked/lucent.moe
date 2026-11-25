import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import type { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import type { AuthDeps } from "../src/auth/deps.ts";
import { mintSession, readSession } from "../src/auth/sessions.ts";
import { chooseUsername, redeemSetupLink } from "../src/auth/setup.ts";
import { signInWithPassword } from "../src/auth/sign-in.ts";
import { readStanding } from "../src/authority/standing.ts";
import { type Db, execute, queryAll, type SqlFragment, sql, sqlIdent } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { DELETION_GRACE_MS } from "../src/deletion/deletion.rules.ts";
import { cancelDeletion, readDeletion, requestDeletion } from "../src/deletion/deletion.ts";
import { ACCOUNT_REFERENCES } from "../src/deletion/references.ts";
import { completeDeletion } from "../src/deletion/strip.ts";
import { MEMBER_PASSWORD, newMember, newSetupLink, seedRootOnce } from "./auth-fixtures.ts";
import { dbNow, grantRole, scalar, seedRole } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

type World = { readonly deps: AuthDeps; readonly db: Db; readonly rng: SeededRng };

function inWorld(seed: number, run: (world: World) => Promise<void>) {
    return async () => {
        await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
            const rng = createSeededRng(seed);
            const deps = await createTestAuthDeps(db, rng);
            await seedRootOnce(db, rng);
            await run({ deps, db, rng });
        });
    };
}

const count = (db: Db, statement: SqlFragment) => scalar(db, z.coerce.number(), statement);

// The grace period, passed: what the job would find a week later.
async function lapse(db: Db, accountId: AccountId) {
    const moved = await execute(
        db,
        sql`update account set deletion_requested_at = now() - interval '8 days',
                deletion_due_at = now() - interval '1 day'
            where id = ${accountId}`,
    );
    expect(moved).toEqual(ok(1));
}

// A session that last proved a factor longer ago than a request accepts.
async function staleSession(db: Db, accountId: AccountId) {
    const aged = await execute(
        db,
        sql`update browser_session set authenticated_at = now() - interval '1 hour',
                step_up_at = null, created_at = now() - interval '1 hour'
            where account_id = ${accountId}`,
    );
    expect(aged.ok).toBe(true);
}

test(
    "a request waits seven days, tells the member, and asking again keeps the date",
    inWorld(1301, async ({ deps, db, rng }) => {
        const ann = await newMember(deps, rng, { username: "ann", with: "passkey" });
        const now = await dbNow(db);
        const requested = await requestDeletion(deps, { token: ann.sessionToken, client: null });
        invariant(requested.ok, `requesting failed: ${JSON.stringify(requested)}`);
        expect(requested.value.dueAt - now).toBeGreaterThanOrEqual(DELETION_GRACE_MS - 1_000);
        expect(requested.value.dueAt - now).toBeLessThanOrEqual(DELETION_GRACE_MS + 1_000);

        expect(await readDeletion(db, ann.sessionToken)).toMatchObject(
            ok({ state: "pending", dueAt: requested.value.dueAt }),
        );
        expect(await requestDeletion(deps, { token: ann.sessionToken, client: null })).toEqual(
            ok({ dueAt: requested.value.dueAt }),
        );
        expect(
            await count(
                db,
                sql`select count(*) as value from audit
                    where operation = 'account.deletion_requested'
                      and target ->> 'accountId' = ${ann.accountId}`,
            ),
        ).toBe(1);
        expect(
            await count(
                db,
                sql`select count(*) as value from inbox_entry
                    where account_id = ${ann.accountId} and kind = 'security'`,
            ),
        ).toBe(1);
        expect(
            await count(
                db,
                sql`select count(*) as value from mail_outbox where recipient = 'ann@lucent.test'`,
            ),
        ).toBe(1);
    }),
);

test(
    "while a deletion waits the account works as before, and only the member's say-so keeps it",
    inWorld(1302, async ({ deps, db, rng }) => {
        const bea = await newMember(deps, rng, { username: "bea", with: "password+totp" });
        const requested = await requestDeletion(deps, { token: bea.sessionToken, client: null });
        invariant(requested.ok, "requesting failed");
        // Signing in again changes nothing about it.
        const signedIn = await signInWithPassword(deps, {
            username: "bea",
            password: MEMBER_PASSWORD,
        });
        expect(signedIn.ok && signedIn.value.next).toBe("secondFactor");
        const standing = await readStanding(db, bea.accountId, await dbNow(db));
        expect(standing.ok && standing.value?.isActive).toBe(true);
        expect((await readDeletion(db, bea.sessionToken)).ok).toBe(true);
        expect(await readDeletion(db, bea.sessionToken)).toMatchObject(ok({ state: "pending" }));

        expect(await cancelDeletion(db, { token: bea.sessionToken, client: null })).toEqual(
            ok(undefined),
        );
        expect(await readDeletion(db, bea.sessionToken)).toEqual(ok({ state: "none" }));
        // Keeping an account kept already writes nothing more.
        expect(await cancelDeletion(db, { token: bea.sessionToken, client: null })).toEqual(
            ok(undefined),
        );
        expect(
            await count(
                db,
                sql`select count(*) as value from audit
                    where operation = 'account.deletion_cancelled'
                      and target ->> 'accountId' = ${bea.accountId}`,
            ),
        ).toBe(1);
        // A cancelled request never completes.
        expect(await completeDeletion(deps, bea.accountId)).toEqual(err({ code: "NOT_PENDING" }));
    }),
);

test(
    "a request needs a factor proven within five minutes, and staff or root can't ask",
    inWorld(1303, async ({ deps, db, rng }) => {
        const cai = await newMember(deps, rng, { username: "cai", with: "passkey" });
        await staleSession(db, cai.accountId);
        expect(await requestDeletion(deps, { token: cai.sessionToken, client: null })).toEqual(
            err({ code: "REAUTH_REQUIRED", withinSeconds: 300 }),
        );

        const dee = await newMember(deps, rng, { username: "dee", with: "passkey" });
        const roleId = await seedRole(db, { id: "role_helper", rank: 1, permissions: [] });
        await grantRole(db, { accountId: dee.accountId, roleId });
        expect(await requestDeletion(deps, { token: dee.sessionToken, client: null })).toEqual(
            err({ code: "STAFF_CANNOT_DELETE" }),
        );
        const rootId = await seedRootOnce(db, rng);
        const rootSession = await withTx(db, async (tx, txNow) => {
            return await mintSession(tx, {
                rng,
                accountId: rootId,
                purpose: "member",
                txNow,
                client: null,
            });
        });
        invariant(rootSession.ok, "a root session");
        expect(
            await requestDeletion(deps, { token: rootSession.value.token, client: null }),
        ).toEqual(err({ code: "STAFF_CANNOT_DELETE" }));
    }),
);

test(
    "completion waits for the date, and a role granted meanwhile holds it",
    inWorld(1304, async ({ deps, db, rng }) => {
        const eve = await newMember(deps, rng, { username: "eve", with: "passkey" });
        invariant(
            (await requestDeletion(deps, { token: eve.sessionToken, client: null })).ok,
            "requesting failed",
        );
        expect(await completeDeletion(deps, eve.accountId)).toEqual(err({ code: "NOT_DUE" }));
        await lapse(db, eve.accountId);
        const roleId = await seedRole(db, { id: "role_helper", rank: 1, permissions: [] });
        await grantRole(db, { accountId: eve.accountId, roleId });
        expect(await completeDeletion(deps, eve.accountId)).toEqual(
            err({ code: "STAFF_CANNOT_DELETE" }),
        );
        await execute(db, sql`delete from account_role where account_id = ${eve.accountId}`);
        expect((await completeDeletion(deps, eve.accountId)).ok).toBe(true);
        expect(await completeDeletion(deps, eve.accountId)).toEqual(
            err({ code: "ACCOUNT_DELETED" }),
        );
    }),
);

test(
    "a completed deletion signs in to nothing, retires the username and empties every column that goes",
    inWorld(1305, async ({ deps, db, rng }) => {
        const fay = await newMember(deps, rng, { username: "fay", with: "all" });
        invariant(
            (await requestDeletion(deps, { token: fay.sessionToken, client: null })).ok,
            "requesting failed",
        );
        await lapse(db, fay.accountId);
        const completed = await completeDeletion(deps, fay.accountId);
        expect(completed).toEqual(
            ok({ accountId: fay.accountId, suspended: false, entitlementsRevoked: [] }),
        );

        // As an address and a name that never existed.
        expect(
            await signInWithPassword(deps, { username: "fay", password: MEMBER_PASSWORD }),
        ).toEqual(err({ code: "INVALID_CREDENTIALS" }));
        expect(
            await withTx(db, (tx, txNow) =>
                readSession(tx, { token: fay.sessionToken, txNow, purposes: ["member", "appeal"] }),
            ),
        ).toEqual(err({ code: "SESSION_INVALID" }));
        const standing = await readStanding(db, fay.accountId, await dbNow(db));
        expect(standing.ok && standing.value?.isActive).toBe(false);

        // Nobody takes the name, nor a look-alike of it.
        for (const [email, username] of [
            ["fay2@lucent.test", "fay"],
            ["fay3@lucent.test", "f_ay"],
        ] as const) {
            const link = await newSetupLink(deps, rng, email);
            const setup = await redeemSetupLink(deps, { setupToken: link.setupToken });
            invariant(setup.ok, "the setup link redeems");
            expect(
                await chooseUsername(deps, { sessionToken: setup.value.sessionToken, username }),
            ).toEqual(err({ code: "USERNAME_TAKEN" }));
        }
        // And the address is free: an account can be made for it again.
        const again = await newSetupLink(deps, rng, "fay@lucent.test");
        expect(again.accountId).not.toBe(fay.accountId);

        for (const [column, fate] of Object.entries(ACCOUNT_REFERENCES)) {
            if (fate.fate !== "goes" || column === "receipt.principal") continue;
            const [table, name] = column.split(".");
            invariant(table !== undefined && name !== undefined, "table.column");
            const left = await queryAll(
                db,
                z.object({ n: z.coerce.number() }),
                sql`select count(*) as n from ${sqlIdent(table)}
                    where ${sqlIdent(name)} = ${fay.accountId}`,
            );
            expect({ column, left: left.ok ? left.value[0]?.n : left }).toEqual({
                column,
                left: 0,
            });
        }
    }),
);
