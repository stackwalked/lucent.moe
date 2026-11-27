import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { listBlocks, setBlock } from "../src/members/community/blocks.ts";
import { exportOwnData } from "../src/members/community/export.ts";
import { readProfile, setBio, setVisibility } from "../src/members/community/profiles.ts";
import { createShout, listShouts } from "../src/members/community/shouts.ts";
import { createWallComment, listWall } from "../src/members/community/wall.ts";
import { createReport } from "../src/members/moderation/reports.ts";
import { setRestriction } from "../src/members/moderation/restrictions.ts";
import { catalog } from "./authority-fixtures.ts";
import { member, moderator } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();

test("a blocked account's wall comments, shouts and profile are absent for the blocker, and the blocker's for them", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9401);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const carol = await member(db, rng, "carol@lucent.test", "carol");
        const comments: Record<string, string> = {};
        for (const [who, text] of [
            [alice, "from alice"],
            [bob, "from bob"],
            [carol, "from carol"],
        ] as const) {
            const comment = await createWallComment(db, who.token, {
                username: "carol",
                body: text,
            });
            invariant(comment.ok, "expected a comment");
            comments[text] = comment.value.id;
            const shout = await createShout(db, who.token, {
                catalog: products,
                productId: null,
                body: text,
            });
            invariant(shout.ok, "expected a shout");
        }
        const view = async (who: typeof alice) => ({
            comments: await listWall(db, who.token, { username: "carol", cursor: null }).then(
                (r) => (r.ok ? r.value.items.map((c) => c.body).sort() : r.error.code),
            ),
            shouts: await listShouts(db, who.token, {
                catalog: products,
                productId: null,
                cursor: null,
            }).then((r) => (r.ok ? r.value.items.map((s) => s.body).sort() : r.error.code)),
        });
        expect((await view(alice)).shouts).toEqual(["from alice", "from bob", "from carol"]);

        expect(await setBlock(db, alice.token, { username: "Bob", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await setBlock(db, alice.token, { username: "bob", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await setBlock(db, alice.token, { username: "alice", blocked: true })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        // Neither sees the other's writing.
        expect(await view(alice)).toEqual({
            comments: ["from alice", "from carol"],
            shouts: ["from alice", "from carol"],
        });
        expect(await view(bob)).toEqual({
            comments: ["from bob", "from carol"],
            shouts: ["from bob", "from carol"],
        });
        expect(await view(carol)).toEqual({
            comments: ["from alice", "from bob", "from carol"],
            shouts: ["from alice", "from bob", "from carol"],
        });
        expect(await readProfile(db, alice.token, { username: "bob" })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        expect(await readProfile(db, bob.token, { username: "alice" })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        expect((await readProfile(db, carol.token, { username: "bob" })).ok).toBe(true);
        expect(
            await createWallComment(db, bob.token, { username: "alice", body: "still here?" }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        expect(
            await createReport(db, alice.token, {
                catalog: products,
                kind: "comment",
                targetId: comments["from bob"] ?? "",
                reason: "spam",
                note: "",
            }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        // The blocker sees only their own list; the blocked account is told nothing.
        const mine = await listBlocks(db, alice.token);
        invariant(mine.ok, "expected the list");
        expect(mine.value.blocks.map((b) => b.username)).toEqual(["bob"]);
        expect(await listBlocks(db, bob.token)).toEqual(ok({ blocks: [] }));

        expect(await setBlock(db, alice.token, { username: "bob", blocked: false })).toEqual(
            ok(undefined),
        );
        expect((await view(alice)).shouts).toEqual(["from alice", "from bob", "from carol"]);
        expect((await view(alice)).comments).toEqual(["from alice", "from bob", "from carol"]);
    });
});

test("a private profile opens only for its owner, and hiding it is not posting", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9402);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        expect(await setBio(db, alice.token, { bio: "hello" })).toEqual(ok(undefined));
        expect((await readProfile(db, bob.token, { username: "alice" })).ok).toBe(true);
        const barred = await setRestriction({
            db,
            catalog: products,
            caller: mod.caller,
            username: "alice",
            kind: "barred",
            productId: null,
            reason: "x",
            endsAt: null,
        });
        invariant(barred.ok, "expected a restriction");
        expect(await setVisibility(db, alice.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect(await readProfile(db, bob.token, { username: "alice" })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        const own = await readProfile(db, alice.token, { username: "alice" });
        invariant(own.ok, "expected the owner to see it");
        expect(own.value).toMatchObject({ bio: "hello", visibility: "private", isSelf: true });
        // Hiding a profile that never had a row creates one with an empty bio.
        expect(await setVisibility(db, bob.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect(await readProfile(db, alice.token, { username: "bob" })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
    });
});

test("the export is the account's own data in one document and nothing of anyone else's", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9403);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        invariant(
            (
                await createShout(db, alice.token, {
                    catalog: products,
                    productId: null,
                    body: "alice shout",
                })
            ).ok,
            "expected a shout",
        );
        invariant(
            (await createWallComment(db, bob.token, { username: "alice", body: "bob comment" })).ok,
            "expected a comment",
        );
        invariant(
            (
                await createShout(db, bob.token, {
                    catalog: products,
                    productId: null,
                    body: "bob shout",
                })
            ).ok,
            "expected a shout",
        );
        expect(await setBio(db, alice.token, { bio: "alice bio" })).toEqual(ok(undefined));
        expect(await setBlock(db, alice.token, { username: "bob", blocked: true })).toEqual(
            ok(undefined),
        );
        invariant(
            (
                await setRestriction({
                    db,
                    catalog: products,
                    caller: mod.caller,
                    username: "alice",
                    kind: "muted",
                    productId: null,
                    reason: "staff only",
                    endsAt: null,
                })
            ).ok,
            "expected a restriction",
        );
        const mine = await exportOwnData(db, alice.token);
        invariant(mine.ok, "expected the export");
        expect(mine.value.account).toMatchObject({ email: "alice@lucent.test", username: "alice" });
        expect(mine.value.profile).toEqual({
            bio: "alice bio",
            visibility: "members",
            removedAt: null,
            avatar: null,
        });
        expect(mine.value.shouts.map((s) => s.body)).toEqual(["alice shout"]);
        expect(mine.value.comments).toEqual([]);
        expect(mine.value.blocks.map((b) => b.username)).toEqual(["bob"]);
        expect(mine.value.restrictions.map((r) => r.kind)).toEqual(["muted"]);
        const text = JSON.stringify(mine.value);
        for (const foreign of ["bob comment", "bob shout", "bob@lucent.test", "staff only"]) {
            expect(text).not.toContain(foreign);
        }
        const theirs = await exportOwnData(db, bob.token);
        invariant(theirs.ok, "expected the export");
        expect(theirs.value.comments.map((c) => c.body)).toEqual(["bob comment"]);
        expect(theirs.value.comments.map((c) => c.profileUsername)).toEqual(["alice"]);
        expect(JSON.stringify(theirs.value)).not.toContain("alice shout");
    });
});
