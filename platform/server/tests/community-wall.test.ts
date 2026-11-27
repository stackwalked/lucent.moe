import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { execute, queryAll, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { setBlock } from "../src/members/community/blocks.ts";
import { createComment, listComments } from "../src/members/community/comments.ts";
import { exportOwnData } from "../src/members/community/export.ts";
import { createGuide } from "../src/members/community/guides.ts";
import { readProfile, setShows, setVisibility } from "../src/members/community/profiles.ts";
import { createWallComment, deleteWallComment, listWall } from "../src/members/community/wall.ts";
import { createReport, resolveReport } from "../src/members/moderation/reports.ts";
import { setRestriction } from "../src/members/moderation/restrictions.ts";
import { catalog, seedRole, seedStaff, waitForLockWaiters } from "./authority-fixtures.ts";
import { member, moderator, sessionFor } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const loader = ProductId.parse("lucent-loader");
const missing = err({ code: "NOT_FOUND" });

type Db = Parameters<typeof listWall>[0];
type Token = Parameters<typeof listWall>[1];

async function wall(db: Db, token: Token, username: string, cursor: string | null = null) {
    return await listWall(db, token, { username, cursor });
}

async function wallBodies(db: Db, token: Token, username: string) {
    const page = await wall(db, token, username);
    invariant(page.ok, `expected a wall, got ${JSON.stringify(page)}`);
    return page.value.items.map((item) => item.body);
}

async function post(db: Db, token: Token, username: string, body: string) {
    return await createWallComment(db, token, { username, body });
}

test("a member writes on another's wall, reads it newest first, and sees who may delete what", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18501);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const carol = await member(db, rng, "carol@lucent.test", "carol");

        const first = await post(db, alice.token, "owner", "first");
        invariant(first.ok, "expected a comment");
        const second = await post(db, carol.token, "Owner", "second");
        invariant(second.ok, "expected a comment");
        // Posts are a window apart, so order the two by hand.
        await execute(
            db,
            sql`update comment set created_at = now() - interval '1 hour' where id = ${first.value.id}::uuid`,
        );

        const asAlice = await wall(db, alice.token, "owner");
        invariant(asAlice.ok, "expected the wall");
        expect(
            asAlice.value.items.map((item) => [item.body, item.author.username, item.canDelete]),
        ).toEqual([
            ["second", "carol", false],
            ["first", "alice", true],
        ]);
        expect(asAlice.value.nextCursor).toBeNull();
        const asOwner = await wall(db, owner.token, "owner");
        invariant(asOwner.ok, "expected the wall");
        expect(asOwner.value.items.map((item) => item.canDelete)).toEqual([true, true]);

        // Neither a guide's comments nor a wall's cross over.
        const guide = await createGuide(db, owner.token, {
            catalog: products,
            productId: loader,
            title: "setup",
            body: "steps",
        });
        invariant(guide.ok, "expected a guide");
        const onGuide = await createComment(db, alice.token, {
            catalog: products,
            guideId: guide.value.id,
            body: "on the guide",
        });
        expect(onGuide.ok).toBe(true);
        const guideComments = await listComments(db, owner.token, {
            catalog: products,
            guideId: guide.value.id,
            cursor: null,
        });
        invariant(guideComments.ok, "expected comments");
        expect(guideComments.value.items.map((item) => item.body)).toEqual(["on the guide"]);
        expect(await wallBodies(db, owner.token, "owner")).toEqual(["second", "first"]);
    });
});

test("a wall pages 25 at a time, newest first, by a cursor that stays put", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18502);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const inserted = await execute(
            db,
            sql`insert into comment (profile_account_id, author_id, body, created_at)
                select ${owner.id}, ${alice.id}, 'c' || lpad(n::text, 2, '0'),
                       now() - n * interval '1 minute'
                from generate_series(1, 30) n`,
        );
        invariant(inserted.ok, "expected the rows");
        const first = await wall(db, alice.token, "owner");
        invariant(first.ok && first.value.nextCursor !== null, "expected a second page");
        expect(first.value.items.length).toBe(25);
        expect(first.value.items[0]?.body).toBe("c01");
        const second = await wall(db, alice.token, "owner", first.value.nextCursor);
        invariant(second.ok, "expected the second page");
        expect(second.value.items.map((item) => item.body)).toEqual([
            "c26",
            "c27",
            "c28",
            "c29",
            "c30",
        ]);
        expect(second.value.nextCursor).toBeNull();
    });
});

test("who may delete a wall comment: its author and the wall's owner, nobody else", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18503);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const carol = await member(db, rng, "carol@lucent.test", "carol");
        const one = await post(db, alice.token, "owner", "one");
        const two = await post(db, alice.token, "owner", "two");
        invariant(one.ok && two.ok, "expected comments");

        expect(await deleteWallComment(db, carol.token, { id: one.value.id })).toEqual(missing);
        expect(await wallBodies(db, owner.token, "owner")).toEqual(["two", "one"]);
        expect(await deleteWallComment(db, alice.token, { id: one.value.id })).toEqual(
            ok(undefined),
        );
        expect(await deleteWallComment(db, owner.token, { id: two.value.id })).toEqual(
            ok(undefined),
        );
        expect(await wallBodies(db, owner.token, "owner")).toEqual([]);
        // Again, nothing changes; a guide's comment is not a wall's to delete here.
        expect(await deleteWallComment(db, alice.token, { id: one.value.id })).toEqual(
            ok(undefined),
        );
        const guide = await createGuide(db, owner.token, {
            catalog: products,
            productId: loader,
            title: "setup",
            body: "steps",
        });
        invariant(guide.ok, "expected a guide");
        const onGuide = await createComment(db, alice.token, {
            catalog: products,
            guideId: guide.value.id,
            body: "mine",
        });
        invariant(onGuide.ok, "expected a comment");
        expect(await deleteWallComment(db, alice.token, { id: onGuide.value.id })).toEqual(missing);
    });
});

test("blocks either way, a private profile and a tombstone make a wall a missing one", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18504);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const blocker = await member(db, rng, "blocker@lucent.test", "blocker");
        const blocked = await member(db, rng, "blocked@lucent.test", "blocked");
        const other = await member(db, rng, "other@lucent.test", "other");
        const gone = await member(db, rng, "gone@lucent.test", "gone");
        const seen = await post(db, other.token, "owner", "seen by most");
        invariant(seen.ok, "expected a comment");

        // The viewer blocks the owner; the owner blocks the viewer.
        expect(await setBlock(db, blocker.token, { username: "owner", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await setBlock(db, owner.token, { username: "blocked", blocked: true })).toEqual(
            ok(undefined),
        );
        for (const viewer of [blocker, blocked]) {
            expect(await wall(db, viewer.token, "owner")).toEqual(missing);
            expect(await post(db, viewer.token, "owner", "hi")).toEqual(missing);
        }
        // A block between viewer and a comment's author hides that comment, not the wall.
        expect(await setBlock(db, other.token, { username: "gone", blocked: true })).toEqual(
            ok(undefined),
        );
        const stranger = await post(db, gone.token, "owner", "from gone");
        invariant(stranger.ok, "expected a comment");
        expect(await wallBodies(db, other.token, "owner")).toEqual(["seen by most"]);
        expect(await wallBodies(db, owner.token, "owner")).toEqual(["from gone", "seen by most"]);

        // A private profile is the owner's alone.
        expect(await setVisibility(db, owner.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect(await wall(db, other.token, "owner")).toEqual(missing);
        expect(await post(db, other.token, "owner", "hi")).toEqual(missing);
        expect(await wallBodies(db, owner.token, "owner")).toEqual(["from gone", "seen by most"]);
        expect((await post(db, owner.token, "owner", "my own wall")).ok).toBe(true);

        // A tombstone has no username.
        const stripped = await withTx(db, async (tx) => {
            const allowed = await execute(
                tx,
                sql`select set_config('lucent.username_rename', 'on', true)`,
            );
            if (!allowed.ok) return allowed;
            return await execute(tx, sql`update account set username = null where id = ${gone.id}`);
        });
        expect(stripped).toEqual({ ok: true, value: 1 });
        expect(await wall(db, other.token, "gone")).toEqual(missing);
        expect(await post(db, other.token, "gone", "hi")).toEqual(missing);
    });
});

test("show_wall off empties the wall for others and closes writing to it; the owner keeps theirs", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18505);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        expect((await post(db, alice.token, "owner", "before")).ok).toBe(true);
        const open = await readProfile(db, alice.token, { username: "owner" });
        invariant(open.ok, "expected the profile");
        expect(open.value.wall).toBe(true);

        expect(await setShows(db, owner.token, { wall: false })).toEqual(ok(undefined));
        expect(await wallBodies(db, alice.token, "owner")).toEqual([]);
        expect(await post(db, alice.token, "owner", "after")).toEqual(missing);
        const hidden = await readProfile(db, alice.token, { username: "owner" });
        invariant(hidden.ok, "expected the profile");
        expect(hidden.value.wall).toBe(false);
        const own = await readProfile(db, owner.token, { username: "owner" });
        invariant(own.ok, "expected the profile");
        expect(own.value.wall).toBe(true);
        expect(await wallBodies(db, owner.token, "owner")).toEqual(["before"]);
        expect((await post(db, owner.token, "owner", "mine")).ok).toBe(true);
    });
});

test("a muted or barred author is refused on a wall as on a guide, and deleting is never refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18506);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const aliceComment = await post(db, alice.token, "owner", "before the mute");
        invariant(aliceComment.ok, "expected a comment");
        for (const [username, kind] of [
            ["alice", "muted"],
            ["bob", "barred"],
        ] as const) {
            const set = await setRestriction({
                db,
                catalog: products,
                caller: mod.caller,
                username,
                kind,
                productId: null,
                reason: "spam",
                endsAt: null,
            });
            invariant(set.ok, "expected a restriction");
        }
        for (const [viewer, kind] of [
            [alice, "muted"],
            [bob, "barred"],
        ] as const) {
            expect(await post(db, viewer.token, "owner", "hi")).toEqual(
                err({ code: "POSTING_RESTRICTED", kind, productId: null, endsAt: null }),
            );
        }
        expect(await deleteWallComment(db, alice.token, { id: aliceComment.value.id })).toEqual(
            ok(undefined),
        );
        expect(await wallBodies(db, owner.token, "owner")).toEqual([]);
    });
});

test("the daily post cap counts wall comments with comments and shouts", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18507);
        await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        let refusal: unknown = null;
        for (let n = 0; n < 40 && refusal === null; n++) {
            const posted = await post(db, alice.token, "owner", `c${n}`);
            if (!posted.ok) refusal = posted.error;
        }
        expect(refusal).toEqual({ code: "LIMIT_REACHED", limit: "posts" });
    });
});

test("exactly one of a guide and a profile is a comment's target", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18508);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const guide = await createGuide(db, owner.token, {
            catalog: products,
            productId: loader,
            title: "setup",
            body: "steps",
        });
        invariant(guide.ok, "expected a guide");
        const both = await execute(
            db,
            sql`insert into comment (guide_id, profile_account_id, author_id, body)
                values (${guide.value.id}::uuid, ${owner.id}, ${owner.id}, 'both')`,
        );
        expect(both.ok).toBe(false);
        const neither = await execute(
            db,
            sql`insert into comment (author_id, body) values (${owner.id}, 'neither')`,
        );
        expect(neither.ok).toBe(false);
        const ok1 = await execute(
            db,
            sql`insert into comment (profile_account_id, author_id, body)
                values (${owner.id}, ${owner.id}, 'wall')`,
        );
        expect(ok1).toEqual({ ok: true, value: 1 });
    });
});

test("a report on a wall comment resolves and removes like any comment, and the export names the wall", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18509);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const carol = await member(db, rng, "carol@lucent.test", "carol");
        const rude = await post(db, alice.token, "owner", "rude");
        invariant(rude.ok, "expected a comment");

        const exported = await exportOwnData(db, alice.token);
        invariant(exported.ok, "expected the export");
        expect(
            exported.value.comments?.map((item) => [item.guideId, item.profileUsername, item.body]),
        ).toEqual([[null, "owner", "rude"]]);

        expect(
            await createReport(db, carol.token, {
                catalog: products,
                kind: "comment",
                targetId: rude.value.id,
                reason: "abuse",
                note: "",
            }),
        ).toEqual(ok(undefined));
        const reports = await queryAll(
            db,
            (await import("zod")).z.object({ id: (await import("zod")).z.uuid() }),
            sql`select id from report where state = 'open'`,
        );
        invariant(reports.ok && reports.value[0] !== undefined, "expected a report");
        const resolved = await resolveReport({
            db,
            caller: mod.caller,
            id: reports.value[0].id,
            outcome: "remove",
        });
        expect(resolved).toEqual(ok({ removed: { kind: "comment", id: rude.value.id } }));
        expect(await wallBodies(db, owner.token, "owner")).toEqual([]);
    });
});

test("a post refuses when the owner turns show_wall off or the profile private while it waits for the owner's row", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18511);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        for (const change of [
            sql`insert into profile (account_id, bio, show_wall) values (${owner.id}, '', false)`,
            sql`insert into profile (account_id, bio, visibility) values (${owner.id}, '', 'private')`,
        ]) {
            const racing: ReturnType<typeof post>[] = [];
            let parked = false;
            const gate = await withTx(db, async (tx) => {
                const held = await execute(
                    tx,
                    sql`select 1 from account where id = ${owner.id} for update`,
                );
                invariant(held.ok, "the gate holds the owner's row");
                const changed = await execute(tx, change);
                invariant(changed.ok, "the gate writes the profile");
                racing.push(post(db, alice.token, "owner", "too late"));
                parked = await waitForLockWaiters(db, 1);
                return ok(undefined);
            });
            expect(gate.ok).toBe(true);
            expect(parked).toBe(true);
            invariant(racing[0] !== undefined, "expected the post");
            expect(await racing[0]).toEqual(missing);
            expect(
                await execute(db, sql`delete from profile where account_id = ${owner.id}`),
            ).toEqual({ ok: true, value: 1 });
        }
    });
});

test("a suspended account's wall is missing to members and still there for staff reading accounts", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18512);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const reader = await seedRole(db, {
            id: "role_reader",
            rank: 5,
            permissions: ["accounts:read"],
        });
        const staffId = await seedStaff(db, rng, { email: "reader@lucent.test", roleId: reader });
        const staffToken = await sessionFor(db, rng, staffId);
        expect((await post(db, alice.token, "owner", "before")).ok).toBe(true);

        expect(
            await execute(db, sql`update account set status = 'suspended' where id = ${owner.id}`),
        ).toEqual({ ok: true, value: 1 });
        expect(await wall(db, alice.token, "owner")).toEqual(missing);
        expect(await post(db, alice.token, "owner", "after")).toEqual(missing);
        expect(await wallBodies(db, staffToken, "owner")).toEqual(["before"]);
    });
});

test("two members writing on each other's walls at once never wait on each other in a cycle", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18513);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        for (let round = 0; round < 10; round++) {
            const results = await Promise.all([
                post(db, alice.token, "bob", `a${round}`),
                post(db, bob.token, "alice", `b${round}`),
            ]);
            expect(results.map((result) => result.ok)).toEqual([true, true]);
        }
    });
});
