import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { type AccountId, RoleId } from "@lucent/core/scalars";
import { execute, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { setBlock } from "../src/members/community/blocks.ts";
import { DIRECTORY_PAGE, listMembers } from "../src/members/community/directory.ts";
import { setVisibility } from "../src/members/community/profiles.ts";
import { grantRole, seedRole } from "./authority-fixtures.ts";
import { member } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

type Db = Parameters<typeof listMembers>[0];

async function listAs(
    db: Db,
    token: Parameters<typeof listMembers>[1],
    params: Parameters<typeof listMembers>[2] = {},
) {
    const reply = await listMembers(db, token, params);
    invariant(reply.ok, `expected a page, got ${JSON.stringify(reply)}`);
    return reply.value;
}

test("the directory leaves out private, suspended, tombstoned and blocked accounts, and keeps the viewer's own private row", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18201);
        const viewer = await member(db, rng, "viewer@lucent.test", "viewer");
        await member(db, rng, "open@lucent.test", "open");
        const priv = await member(db, rng, "priv@lucent.test", "priv");
        const suspended = await member(db, rng, "susp@lucent.test", "susp");
        await member(db, rng, "blocked@lucent.test", "blocked");
        const blocker = await member(db, rng, "blocker@lucent.test", "blocker");
        const tomb = await member(db, rng, "tomb@lucent.test", "tomb");

        expect(await setVisibility(db, priv.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect(await setVisibility(db, viewer.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect(
            await execute(
                db,
                sql`update account set status = 'suspended' where id = ${suspended.id}`,
            ),
        ).toEqual({ ok: true, value: 1 });
        expect(await setBlock(db, viewer.token, { username: "blocked", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await setBlock(db, blocker.token, { username: "viewer", blocked: true })).toEqual(
            ok(undefined),
        );
        // A tombstone has no username; the rename guard must be lifted inside one transaction.
        const stripped = await withTx(db, async (tx) => {
            const allowed = await execute(
                tx,
                sql`select set_config('lucent.username_rename', 'on', true)`,
            );
            if (!allowed.ok) return allowed;
            return await execute(tx, sql`update account set username = null where id = ${tomb.id}`);
        });
        expect(stripped).toEqual({ ok: true, value: 1 });

        const page = await listAs(db, viewer.token);
        const names = page.items.map((row) => row.username);
        expect(names).toContain("open");
        expect(names).toContain("viewer");
        expect(names).not.toContain("priv");
        expect(names).not.toContain("susp");
        expect(names).not.toContain("blocked");
        expect(names).not.toContain("blocker");
        expect(names).not.toContain("tomb");
        expect(page.total).toBe(names.length);
        expect(page.next).toBeNull();

        // The stranger's row is whole: number, joined day, no role.
        const row = page.items.find((item) => item.username === "open");
        invariant(row !== undefined, "expected the open row");
        expect(row.memberNo).toBeGreaterThan(0);
        expect(typeof row.joinedAt).toBe("number");
        expect(row.role).toBeNull();
        expect(row.avatar).toBeNull();
    });
});

test("the prefix search matches case-insensitively, escapes wildcards, and the total counts only matches", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18202);
        const viewer = await member(db, rng, "viewer@lucent.test", "viewer");
        await member(db, rng, "alice@lucent.test", "alice");
        await member(db, rng, "alina@lucent.test", "alina");
        await member(db, rng, "bob@lucent.test", "bob");
        await member(db, rng, "odd@lucent.test", "odd%name");

        const al = await listAs(db, viewer.token, { text: "AL" });
        expect(al.items.map((row) => row.username)).toEqual(["alice", "alina"]);
        expect(al.total).toBe(2);

        // The percent sign is text, not a wildcard: it matches only the literal name.
        const odd = await listAs(db, viewer.token, { text: "odd%" });
        expect(odd.items.map((row) => row.username)).toEqual(["odd%name"]);
        expect(odd.total).toBe(1);
    });
});

test("both sorts hold their order, paging across the boundary is stable, and a role label rides its row", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18203);
        const viewer = await member(db, rng, "viewer@lucent.test", "viewer");
        const crowd: AccountId[] = [];
        for (let n = 0; n < DIRECTORY_PAGE + 5; n++) {
            const who = await member(
                db,
                rng,
                `crowd${n}@lucent.test`,
                `crowd${String(n).padStart(2, "0")}`,
            );
            crowd.push(who.id);
        }
        // The oldest crowd account carries a coloured role.
        const roleId = RoleId.parse("role_directory_test");
        await seedRole(db, { id: roleId, rank: 3, permissions: [] });
        await execute(db, sql`update role set label_color = 'violet' where id = ${roleId}`);
        const firstCrowd = crowd[0];
        invariant(firstCrowd !== undefined, "expected crowd accounts");
        await grantRole(db, { accountId: firstCrowd, roleId });

        const first = await listAs(db, viewer.token, { sort: "number" });
        expect(first.items.length).toBe(DIRECTORY_PAGE);
        expect(first.total).toBe(DIRECTORY_PAGE + 5 + 1);
        invariant(first.next !== null, "expected a second page");
        const numbers = first.items.map((row) => row.memberNo);
        expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);

        const second = await listAs(db, viewer.token, { sort: "number", cursor: first.next });
        expect(second.items.length).toBe(5 + 1);
        const overlap = second.items.filter((row) =>
            first.items.some((earlier) => earlier.username === row.username),
        );
        expect(overlap).toEqual([]);
        const all = [...first.items, ...second.items].map((row) => row.memberNo);
        expect([...all].sort((a, b) => a - b)).toEqual(all);
        expect(second.next).toBeNull();

        const newest = await listAs(db, viewer.token, { sort: "newest" });
        const joined = newest.items.map((row) => row.joinedAt);
        expect([...joined].sort((a, b) => b - a)).toEqual(joined);

        const labelled = first.items.find((row) => row.username === "crowd00");
        invariant(labelled !== undefined, "expected the crowd row");
        expect(labelled.role).toEqual({ name: "role_directory_test", color: "violet" });
    });
});
