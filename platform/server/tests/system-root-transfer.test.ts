import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import type { AccountId } from "@lucent/core/scalars";
import { ACTIONS } from "@lucent/policy/action-list";
import { can } from "@lucent/policy/policy";
import { runToEnd } from "@lucent/testing/process";
import { z } from "zod";
import { lockSession, mintSession } from "../src/auth/sessions.ts";
import { readStanding } from "../src/authority/standing.ts";
import { checkoutClient, type Db, execute, openPool, queryAll, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { transferRoot } from "../src/system/root-transfer.ts";
import { dbNow, scalar, seedAccount, seedRoot, waitForLockWaiters } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const ROOT_PERMANENT = { code: "CHECK_VIOLATION", constraint: "account_root_permanent" } as const;

async function seedNamed(
    db: Db,
    rng: SeededRng,
    username: string,
    options: { readonly passkey?: boolean } = {},
): Promise<AccountId> {
    const id = await seedAccount(db, rng, `${username}@lucent.test`);
    expect(
        await execute(db, sql`update account set username = ${username} where id = ${id}`),
    ).toEqual(ok(1));
    if (options.passkey !== false) await givePasskey(db, id);
    return id;
}

// The only credential step-up accepts; the key bytes are never verified here.
async function givePasskey(db: Db, accountId: AccountId): Promise<void> {
    expect(
        await execute(
            db,
            sql`insert into passkey (id, account_id, public_key, sign_count, backed_up, label, created_at)
                values (convert_to(${accountId}, 'UTF8'), ${accountId}, decode('00', 'hex'), 0, false, 'test key', now())`,
        ),
    ).toEqual(ok(1));
}

async function roots(db: Db): Promise<readonly string[]> {
    const res = await queryAll(
        db,
        z.object({ id: z.string() }),
        sql`select id from account where is_root`,
    );
    invariant(res.ok, "roots readable");
    return res.value.map((row) => row.id);
}

// Every way of moving root outside the verb, tried on `db`: each must meet the trigger.
async function expectRootFixed(
    db: Db,
    params: { readonly root: AccountId; readonly other: AccountId },
) {
    expect(
        await execute(db, sql`update account set is_root = false where id = ${params.root}`),
    ).toEqual(err(ROOT_PERMANENT));
    expect(
        await execute(db, sql`update account set is_root = true where id = ${params.other}`),
    ).toEqual(err(ROOT_PERMANENT));
    expect(await roots(db)).toEqual([params.root]);
}

describe("ops transfer-superadmin", () => {
    test("root moves to the named account and the old root keeps no root powers", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(1201);
            const oldRoot = await seedRoot(nativeDb, rng);
            const heir = await seedNamed(nativeDb, rng, "heir");

            expect(await transferRoot({ db: nativeDb, username: "Heir" })).toEqual(
                ok({ from: oldRoot, to: heir }),
            );
            expect(await roots(nativeDb)).toEqual([heir]);

            const txNow = await dbNow(nativeDb);
            const before = await readStanding(nativeDb, oldRoot, txNow);
            invariant(before.ok && before.value !== null, "old root still has an account");
            const demoted = { ...before.value, stepUpAt: txNow };
            expect(demoted.isRoot).toBe(false);
            expect(ACTIONS.filter((action) => can(demoted, action))).toEqual([]);
            const after = await readStanding(nativeDb, heir, txNow);
            invariant(after.ok && after.value !== null, "heir has an account");
            const promoted = { ...after.value, stepUpAt: txNow };
            expect(ACTIONS.every((action) => can(promoted, action))).toBe(true);
            // Nothing targets root, the new one included; the old one is an ordinary account now.
            expect(
                can(promoted, "accounts:suspend", { kind: "account", account: before.value }),
            ).toBe(true);
            expect(
                can(demoted, "accounts:suspend", { kind: "account", account: after.value }),
            ).toBe(false);

            const audit = await scalar(
                nativeDb,
                z.object({ operation: z.string(), actor_id: z.string(), target: z.unknown() }),
                sql`select json_build_object('operation', operation, 'actor_id', actor_id,
                                             'target', target) as value
                    from audit where operation = 'account.transfer_root'`,
            );
            expect(audit).toEqual({
                operation: "account.transfer_root",
                actor_id: "cli:transfer-superadmin",
                target: { accountId: heir, fromAccountId: oldRoot },
            });
        });
    });

    test("an account that can't hold root, or holds it, or doesn't exist is refused", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(1202);
            expect(await transferRoot({ db: nativeDb, username: "nobody" })).toEqual(
                err({ code: "NO_ROOT" }),
            );
            const root = await seedRoot(nativeDb, rng);
            const suspended = await seedNamed(nativeDb, rng, "suspended");
            const locked = await seedNamed(nativeDb, rng, "locked");
            await seedNamed(nativeDb, rng, "keyless", { passkey: false });
            await execute(
                nativeDb,
                sql`update account set status = 'suspended' where id = ${suspended}`,
            );
            await execute(nativeDb, sql`update account set is_locked = true where id = ${locked}`);

            expect(await transferRoot({ db: nativeDb, username: "nobody" })).toEqual(
                err({ code: "NOT_FOUND" }),
            );
            expect(await transferRoot({ db: nativeDb, username: "founder" })).toEqual(
                err({ code: "ALREADY_ROOT" }),
            );
            expect(await transferRoot({ db: nativeDb, username: "suspended" })).toEqual(
                err({ code: "TARGET_SUSPENDED" }),
            );
            expect(await transferRoot({ db: nativeDb, username: "locked" })).toEqual(
                err({ code: "TARGET_LOCKED" }),
            );
            expect(await transferRoot({ db: nativeDb, username: "keyless" })).toEqual(
                err({ code: "TARGET_NO_PASSKEY" }),
            );
            expect(await roots(nativeDb)).toEqual([root]);
        });
    });

    test("a transfer that waited while the target's last passkey was removed is refused", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(7306);
            const root = await seedRoot(nativeDb, rng);
            const heir = await seedNamed(nativeDb, rng, "heir");
            // As a credential writer does: the account lock, then the delete, not yet committed.
            const holder = await checkoutClient(nativeDb);
            invariant(holder.ok, "a second connection");
            await holder.value.begin();
            await execute(
                holder.value.tx,
                sql`select 1 from account where id = ${heir} for update`,
            );
            await execute(holder.value.tx, sql`delete from passkey where account_id = ${heir}`);
            const racing = transferRoot({ db: nativeDb, username: "heir" });
            expect(await waitForLockWaiters(nativeDb, 1)).toBe(true);
            await holder.value.commit();
            holder.value.release();
            expect(await racing).toEqual(err({ code: "TARGET_NO_PASSKEY" }));
            expect(await roots(nativeDb)).toEqual([root]);
        });
    });

    test("the old root's sessions end with the transfer but its account stays", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(1206);
            const oldRoot = await seedRoot(nativeDb, rng);
            await seedNamed(nativeDb, rng, "heir");
            const minted = await withTx(nativeDb, (tx, txNow) =>
                mintSession(tx, {
                    rng,
                    accountId: oldRoot,
                    purpose: "member",
                    txNow,
                    client: null,
                }),
            );
            invariant(minted.ok, "minting the old root a session");
            const { token } = minted.value;
            const resolves = () =>
                withTx(nativeDb, (tx, txNow) =>
                    lockSession(tx, { token, txNow, purposes: ["member"] }),
                );
            expect((await resolves()).ok).toBe(true);

            expect((await transferRoot({ db: nativeDb, username: "heir" })).ok).toBe(true);

            expect(await resolves()).toEqual(err({ code: "SESSION_INVALID" }));
            const standing = await readStanding(nativeDb, oldRoot, await dbNow(nativeDb));
            expect(standing.ok && standing.value !== null && !standing.value.isRoot).toBe(true);
        });
    });

    test("the trigger holds again on the same connection after a transfer, a refusal and a rollback", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ databaseUrl, nativeDb }) => {
            const rng = createSeededRng(1203);
            await seedRoot(nativeDb, rng);
            const heir = await seedNamed(nativeDb, rng, "heir");
            const other = await seedNamed(nativeDb, rng, "other");
            await execute(
                nativeDb,
                sql`update account set status = 'suspended' where id = ${other}`,
            );
            // One connection: whatever the verb set on it would still be there for the next use.
            const single = openPool({ databaseUrl, maxConnections: 1 });

            expect((await transferRoot({ db: single, username: "heir" })).ok).toBe(true);
            await expectRootFixed(single, { root: heir, other });

            expect(await transferRoot({ db: single, username: "other" })).toEqual(
                err({ code: "TARGET_SUSPENDED" }),
            );
            await expectRootFixed(single, { root: heir, other });

            // The relaxation names two accounts: a third stays fixed inside it, and a transaction
            // that set it and rolled back leaves nothing behind.
            const relaxedThenRolledBack = await withTx(single, async (tx) => {
                await execute(
                    tx,
                    sql`select set_config('lucent.root_transfer', ${`${heir} ${heir}`}, true)`,
                );
                const third = await execute(
                    tx,
                    sql`update account set is_root = true where id = ${other}`,
                );
                return third.ok ? ok(null) : err(third.error);
            });
            expect(relaxedThenRolledBack).toEqual(err(ROOT_PERMANENT));
            await expectRootFixed(single, { root: heir, other });
            await single.close();
        });
    });

    test("two transfers at once leave one root, and the one that lost the race refuses", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(1204);
            const root = await seedRoot(nativeDb, rng);
            const first = await seedNamed(nativeDb, rng, "first");
            const second = await seedNamed(nativeDb, rng, "second");

            const holder = await checkoutClient(nativeDb);
            invariant(holder.ok, "a connection for the blocker");
            await holder.value.begin();
            await execute(
                holder.value.tx,
                sql`select 1 from account where id = ${root} for update`,
            );
            const racing = [
                transferRoot({ db: nativeDb, username: "first" }),
                transferRoot({ db: nativeDb, username: "second" }),
            ];
            const parked = await waitForLockWaiters(nativeDb, 2);
            await holder.value.commit();
            holder.value.release();
            const outcomes = await Promise.all(racing);
            expect(parked).toBe(true);

            const won = outcomes.filter((outcome) => outcome.ok);
            expect(won).toHaveLength(1);
            expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([err({ code: "NO_ROOT" })]);
            const winner = won[0]?.ok === true ? won[0].value.to : null;
            invariant(winner !== null, "one transfer won");
            expect([first, second]).toContain(winner);
            expect(await roots(nativeDb)).toEqual([winner]);
        });
    });

    test("the verb prints one JSON object, and the trigger holds after it", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ databaseUrl, nativeDb }) => {
            const rng = createSeededRng(1205);
            const root = await seedRoot(nativeDb, rng);
            const heir = await seedNamed(nativeDb, rng, "heir");
            const ran = await runToEnd({
                command: [process.execPath, "src/ops.ts", "transfer-superadmin", "--to", "heir"],
                cwd: join(import.meta.dir, ".."),
                env: { LUCENT_DATABASE_URL: databaseUrl },
            });
            expect(JSON.parse(ran.stdout)).toEqual({ from: root, to: heir });
            expect(ran.stdout.trim().split("\n")).toHaveLength(1);
            await expectRootFixed(nativeDb, { root: heir, other: root });
        });
    });
});
