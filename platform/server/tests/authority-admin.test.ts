import { describe, expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { type AccountId, newOperationId, RoleId } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type AccountSummary,
    listAccounts,
    listAudit,
    PAGE_SIZE,
    readAccount,
} from "../src/authority/reads.ts";
import { readRole } from "../src/authority/standing.ts";
import {
    reinstateAccount,
    renameAccount,
    suspendAccount,
    unassignAccountRole,
    upsertRole,
} from "../src/authority/writers.ts";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { newMember, seedRootOnce } from "./auth-fixtures.ts";
import {
    catalog,
    grantRole,
    scalar,
    seedAccount,
    seedRole,
    seedStaff,
    steppedUp,
} from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const NO_FILTER = { status: null, roleId: null, text: null } as const;

async function everyPage(
    db: Db,
    params: { readonly caller: AccountId; readonly sort: "newest" | "username" },
): Promise<AccountSummary[]> {
    const caller = await steppedUp(db, params.caller);
    const seen: AccountSummary[] = [];
    let cursor: string | null = null;
    for (;;) {
        const page = await listAccounts(db, {
            caller,
            filter: NO_FILTER,
            sort: params.sort,
            cursor,
        });
        invariant(page.ok, `listing failed: ${JSON.stringify(page)}`);
        seen.push(...page.value.items);
        if (page.value.nextCursor === null) return seen;
        cursor = page.value.nextCursor;
    }
}

describe("admin reads", () => {
    test("paging the account list visits every account once, in order, for both sorts", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(601);
            const rootId = await seedRootOnce(nativeDb, rng);
            // Ties on created_at, microseconds inside one millisecond (a cursor holds only
            // milliseconds), and accounts without a username are where keysets slip.
            for (let i = 0; i < PAGE_SIZE + 12; i++) {
                const id = await seedAccount(nativeDb, rng, `user${i}@lucent.test`);
                const micros = String((i * 37) % 1_000).padStart(3, "0");
                await execute(
                    nativeDb,
                    sql`update account set
                            username = ${i % 3 === 0 ? null : `user_${(i * 7) % 61}`},
                            created_at = ${`2026-01-01T00:00:00.000${micros}Z`}::timestamptz
                        where id = ${id}`,
                );
            }
            const total = PAGE_SIZE + 13;

            const newest = await everyPage(nativeDb, { caller: rootId, sort: "newest" });
            expect(new Set(newest.map((a) => a.accountId)).size).toBe(total);
            const createdKeys = newest.map((a) => `${a.createdAt}|${a.accountId}`);
            expect(createdKeys).toEqual([...createdKeys].sort().reverse());

            const byName = await everyPage(nativeDb, { caller: rootId, sort: "username" });
            expect(new Set(byName.map((a) => a.accountId)).size).toBe(total);
            const named = byName.filter((a) => a.username !== null).map((a) => a.username);
            expect(named).toEqual([...named].sort());
            expect(byName.findIndex((a) => a.username === null)).toBe(named.length);
        });
    });

    test("an account is setup pending until it has a way to sign in, and suspended once suspended", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(602);
            const deps = await createTestAuthDeps(browserDb, rng);
            const rootId = await seedRootOnce(browserDb, rng);
            const pending = await seedAccount(nativeDb, rng, "pending@lucent.test");
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            const caller = await steppedUp(nativeDb, rootId);
            const statusOf = async (accountId: AccountId) => {
                const read = await readAccount(nativeDb, { caller, accountId });
                invariant(read.ok, `read failed: ${JSON.stringify(read)}`);
                return read.value.status;
            };

            expect(await statusOf(pending)).toBe("setup_pending");
            expect(await statusOf(alice.accountId)).toBe("active");
            await suspendAccount({
                db: nativeDb,
                caller,
                operationId: newOperationId(rng),
                targetAccountId: alice.accountId,
                reason: "spam",
            });
            expect(await statusOf(alice.accountId)).toBe("suspended");
        });
    });

    test("the text filter matches the start of a username or email, literally", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(603);
            const rootId = await seedRootOnce(nativeDb, rng);
            await seedAccount(nativeDb, rng, "a_b@lucent.test");
            await seedAccount(nativeDb, rng, "axb@lucent.test");
            await seedAccount(nativeDb, rng, "xa_b@lucent.test");
            const listed = await listAccounts(nativeDb, {
                caller: await steppedUp(nativeDb, rootId),
                filter: { ...NO_FILTER, text: "A_B" },
                sort: "newest",
                cursor: null,
            });
            invariant(listed.ok, "listing failed");
            expect(listed.value.items.map((a) => a.email)).toEqual(["a_b@lucent.test"]);
        });
    });

    test("reads need their permission, and recent audit shows only to those who read audit", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(604);
            const rootId = await seedRootOnce(nativeDb, rng);
            const reader = await seedRole(nativeDb, {
                id: "role_reader",
                rank: 1,
                permissions: ["accounts:read"],
            });
            const readerId = await seedStaff(nativeDb, rng, {
                email: "reader@lucent.test",
                roleId: reader,
            });
            const nobody = await seedAccount(nativeDb, rng, "nobody@lucent.test");

            const asReader = await readAccount(nativeDb, {
                caller: await steppedUp(nativeDb, readerId),
                accountId: rootId,
            });
            expect(asReader.ok && asReader.value.recentAudit).toBeNull();
            const asRoot = await readAccount(nativeDb, {
                caller: await steppedUp(nativeDb, rootId),
                accountId: rootId,
            });
            expect(asRoot.ok && asRoot.value.recentAudit?.map((e) => e.operation)).toEqual([
                "account.bootstrap_root",
            ]);
            expect(
                await listAudit(nativeDb, {
                    caller: await steppedUp(nativeDb, readerId),
                    filter: { actorId: null, targetAccountId: null, operation: null, before: null },
                    cursor: null,
                }),
            ).toEqual(err({ code: "FORBIDDEN" }));
            expect(
                await readAccount(nativeDb, {
                    caller: await steppedUp(nativeDb, nobody),
                    accountId: rootId,
                }),
            ).toEqual(err({ code: "FORBIDDEN" }));
        });
    });

    test("a cursor that wasn't handed out is refused", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(605);
            const rootId = await seedRootOnce(nativeDb, rng);
            for (const cursor of ["not-json", "WzEsMl0", "eyJhIjoxfQ"]) {
                expect(
                    await listAccounts(nativeDb, {
                        caller: await steppedUp(nativeDb, rootId),
                        filter: NO_FILTER,
                        sort: "newest",
                        cursor,
                    }),
                ).toEqual(err({ code: "INVALID_CURSOR" }));
            }
        });
    });
});

describe("admin writers", () => {
    test("reinstating a suspended account makes it active again, once per operation", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(611);
            const rootId = await seedRootOnce(nativeDb, rng);
            const target = await seedAccount(nativeDb, rng, "target@lucent.test");
            const caller = await steppedUp(nativeDb, rootId);
            await execute(
                nativeDb,
                sql`update account set status = 'suspended' where id = ${target}`,
            );
            const operationId = newOperationId(rng);

            const first = await reinstateAccount({
                db: nativeDb,
                caller,
                operationId,
                targetAccountId: target,
            });
            const again = await reinstateAccount({
                db: nativeDb,
                caller,
                operationId,
                targetAccountId: target,
            });
            expect([first, again]).toEqual([ok({ replayed: false }), ok({ replayed: true })]);
            expect(
                await scalar(
                    nativeDb,
                    z.string(),
                    sql`select status as value from account where id = ${target}`,
                ),
            ).toBe("active");
            expect(
                await scalar(
                    nativeDb,
                    z.coerce.number(),
                    sql`select count(*) as value from audit where operation = 'account.reinstate'`,
                ),
            ).toBe(1);
        });
    });

    test("a rename keeps the old name claimed, refuses look-alikes of others, and may reclaim its own", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(612);
            const deps = await createTestAuthDeps(browserDb, rng);
            const rootId = await seedRootOnce(browserDb, rng);
            const caller = await steppedUp(nativeDb, rootId);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            await newMember(deps, rng, { username: "bob", with: "passkey" });
            const rename = (accountId: AccountId, username: string) =>
                renameAccount({
                    db: nativeDb,
                    caller,
                    operationId: newOperationId(rng),
                    targetAccountId: accountId,
                    username,
                });

            expect(await rename(alice.accountId, "alicia")).toEqual(
                ok({ username: "alicia", replayed: false }),
            );
            expect(await rename(alice.accountId, "b0b")).toEqual(err({ code: "USERNAME_TAKEN" }));
            const carol = await seedAccount(nativeDb, rng, "carol@lucent.test");
            expect(await rename(carol, "alice")).toEqual(err({ code: "USERNAME_TAKEN" }));
            expect(await rename(alice.accountId, "alice")).toEqual(
                ok({ username: "alice", replayed: false }),
            );
            expect(
                await scalar(
                    nativeDb,
                    z.array(z.string()),
                    sql`select array_agg(skeleton order by skeleton) as value
                        from username_claim where account_id = ${alice.accountId}`,
                ),
            ).toEqual(["allce", "allcla"]);
        });
    });

    test("taking a role away needs to outrank it, and a role not held is already gone", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(613);
            const manager = await seedRole(nativeDb, {
                id: "role_manager",
                rank: 50,
                permissions: ["roles:assign"],
            });
            const senior = await seedRole(nativeDb, {
                id: "role_senior",
                rank: 60,
                permissions: [],
            });
            const junior = await seedRole(nativeDb, {
                id: "role_junior",
                rank: 10,
                permissions: [],
            });
            const managerId = await seedStaff(nativeDb, rng, {
                email: "m@lucent.test",
                roleId: manager,
            });
            const target = await seedAccount(nativeDb, rng, "t@lucent.test");
            await grantRole(nativeDb, { accountId: target, roleId: senior });
            await grantRole(nativeDb, { accountId: target, roleId: junior });
            const caller = await steppedUp(nativeDb, managerId);

            expect(
                await unassignAccountRole({
                    db: nativeDb,
                    caller,
                    targetAccountId: target,
                    roleId: senior,
                }),
            ).toEqual(err({ code: "FORBIDDEN" }));
            await execute(
                nativeDb,
                sql`delete from account_role where account_id = ${target} and role_id = ${senior}`,
            );
            expect(
                await unassignAccountRole({
                    db: nativeDb,
                    caller,
                    targetAccountId: target,
                    roleId: junior,
                }),
            ).toEqual(ok(undefined));
            expect(
                await unassignAccountRole({
                    db: nativeDb,
                    caller,
                    targetAccountId: target,
                    roleId: junior,
                }),
            ).toEqual(ok(undefined));
            expect(
                await scalar(
                    nativeDb,
                    z.coerce.number(),
                    sql`select count(*) as value from audit where operation = 'role.unassign'`,
                ),
            ).toBe(1);
        });
    });

    test("saving a role from the editor keeps its channel grants, and a taken name is refused", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(614);
            const rootId = await seedRootOnce(nativeDb, rng);
            const caller = await steppedUp(nativeDb, rootId);
            const products = catalog();
            const [first] = [...products.values()];
            invariant(first !== undefined, "the catalog has a product");
            const grants = [{ productId: first.id, channels: [...first.channels].sort() }];
            const save = (
                roleId: string,
                name: string,
                channelGrants: typeof grants | "unchanged",
            ) =>
                upsertRole({
                    db: nativeDb,
                    catalog: products,
                    caller,
                    operationId: newOperationId(rng),
                    roleId: RoleId.parse(roleId),
                    name,
                    rank: 5,
                    permissions: [],
                    channelGrants,
                });

            expect((await save("role_tester", "Tester", grants)).ok).toBe(true);
            expect((await save("role_tester", "Testers", "unchanged")).ok).toBe(true);
            const stored = await readRole(nativeDb, RoleId.parse("role_tester"));
            expect(stored.ok && [stored.value.name, stored.value.channelGrants]).toEqual([
                "Testers",
                grants,
            ]);
            expect(await save("role_other", "Testers", "unchanged")).toEqual(
                err({ code: "ROLE_NAME_TAKEN" }),
            );
        });
    });
});
