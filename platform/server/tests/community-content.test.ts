import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { execute, sql } from "../src/base/db/pool.ts";
import { createComment, listComments } from "../src/members/community/comments.ts";
import {
    createGuide,
    listGuides,
    readGuide,
    updateGuide,
} from "../src/members/community/guides.ts";
import { readProfile, setBio } from "../src/members/community/profiles.ts";
import { createShout, listShouts } from "../src/members/community/shouts.ts";
import { setRestriction } from "../src/members/moderation/restrictions.ts";
import { catalog } from "./authority-fixtures.ts";
import { holdProduct, member, moderator } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const loader = ProductId.parse("lucent-loader");
const cs2 = ProductId.parse("cs2");

test("a bar in one product closes that product's guides and comments and nothing else", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9201);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const guide = await createGuide(db, bob.token, {
            catalog: products,
            productId: loader,
            title: "setup",
            body: "steps",
        });
        invariant(guide.ok, "expected a guide");
        const barred = await setRestriction({
            db,
            catalog: products,
            caller: mod.caller,
            username: "alice",
            kind: "barred",
            productId: loader,
            reason: "spam",
            endsAt: null,
        });
        invariant(barred.ok, "expected a restriction");
        const refused = err({
            code: "POSTING_RESTRICTED",
            kind: "barred",
            productId: loader,
            endsAt: null,
        });
        // The comment takes its guide's product, so the bar on that product closes it.
        expect(
            await createComment(db, alice.token, {
                catalog: products,
                guideId: guide.value.id,
                body: "hi",
            }),
        ).toEqual(refused);
        expect(
            await createGuide(db, alice.token, {
                catalog: products,
                productId: loader,
                title: "mine",
                body: "text",
            }),
        ).toEqual(refused);
        expect(
            await createShout(db, alice.token, { catalog: products, productId: loader, body: "x" }),
        ).toEqual(refused);
        // Elsewhere she is free: a shout about no product, her own bio.
        expect(
            (
                await createShout(db, alice.token, {
                    catalog: products,
                    productId: null,
                    body: "hello",
                })
            ).ok,
        ).toBe(true);
        expect(await setBio(db, alice.token, { bio: "hi" })).toEqual(ok(undefined));
        // Reading is not posting.
        expect(
            (
                await listComments(db, alice.token, {
                    catalog: products,
                    guideId: guide.value.id,
                    cursor: null,
                })
            ).ok,
        ).toBe(true);
    });
});

test("a mute closes comments and shouts but leaves guides and the profile open", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9202);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const guide = await createGuide(db, alice.token, {
            catalog: products,
            productId: loader,
            title: "t",
            body: "b",
        });
        invariant(guide.ok, "expected a guide");
        const muted = await setRestriction({
            db,
            catalog: products,
            caller: mod.caller,
            username: "alice",
            kind: "muted",
            productId: null,
            reason: "rude",
            endsAt: null,
        });
        invariant(muted.ok, "expected a restriction");
        const comment = await createComment(db, alice.token, {
            catalog: products,
            guideId: guide.value.id,
            body: "c",
        });
        expect(comment.ok).toBe(false);
        expect(
            (await createShout(db, alice.token, { catalog: products, productId: null, body: "s" }))
                .ok,
        ).toBe(false);
        expect(
            await updateGuide(db, alice.token, {
                catalog: products,
                id: guide.value.id,
                title: "t2",
                body: "b2",
            }),
        ).toEqual(ok(undefined));
        expect(await setBio(db, alice.token, { bio: "still here" })).toEqual(ok(undefined));
    });
});

test("guides, comments and shouts show only to members who may see their product", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9203);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const holder = await member(db, rng, "holder@lucent.test", "holder");
        // cs2 is a seed product: listed only for accounts that hold it.
        await holdProduct(db, rng, holder.id, "cs2");
        const guide = await createGuide(db, holder.token, {
            catalog: products,
            productId: cs2,
            title: "seed",
            body: "text",
        });
        invariant(guide.ok, "expected a guide for the holder");
        expect(
            await createGuide(db, alice.token, {
                catalog: products,
                productId: cs2,
                title: "no",
                body: "no",
            }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        expect(await readGuide(db, alice.token, { catalog: products, id: guide.value.id })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        expect(
            await listGuides(db, alice.token, { catalog: products, productId: cs2, cursor: null }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        expect(
            await createComment(db, alice.token, {
                catalog: products,
                guideId: guide.value.id,
                body: "x",
            }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        expect(
            await listComments(db, alice.token, {
                catalog: products,
                guideId: guide.value.id,
                cursor: null,
            }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        const aboutSeed = await createShout(db, holder.token, {
            catalog: products,
            productId: cs2,
            body: "seed news",
        });
        invariant(aboutSeed.ok, "expected a shout for the holder");
        const open = await createShout(db, holder.token, {
            catalog: products,
            productId: null,
            body: "for all",
        });
        invariant(open.ok, "expected a shout");
        const seen = await listShouts(db, alice.token, {
            catalog: products,
            productId: null,
            cursor: null,
        });
        invariant(seen.ok, "expected the feed");
        expect(seen.value.items.map((item) => item.id)).toEqual([open.value.id]);
        expect(
            await listShouts(db, alice.token, { catalog: products, productId: cs2, cursor: null }),
        ).toEqual(err({ code: "NOT_FOUND" }));
    });
});

test("only a guide's author edits it, comments page oldest first and profiles name their owner", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9204);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const guide = await createGuide(db, alice.token, {
            catalog: products,
            productId: loader,
            title: "t",
            body: "b",
        });
        invariant(guide.ok, "expected a guide");
        expect(
            await updateGuide(db, bob.token, {
                catalog: products,
                id: guide.value.id,
                title: "x",
                body: "y",
            }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        // Seeded directly: posting 27 comments through the writer would meet the rate limit.
        await execute(
            db,
            sql`insert into comment (guide_id, author_id, body, created_at)
                select ${guide.value.id}::uuid, ${bob.id}, 'c' || n, now() - make_interval(secs => 100 - n)
                from generate_series(0, 26) n`,
        );
        const first = await listComments(db, alice.token, {
            catalog: products,
            guideId: guide.value.id,
            cursor: null,
        });
        invariant(first.ok && first.value.nextCursor !== null, "expected a second page");
        expect(first.value.items).toHaveLength(25);
        expect(first.value.items[0]?.body).toBe("c0");
        expect(first.value.items[0]?.isMine).toBe(false);
        const second = await listComments(db, alice.token, {
            catalog: products,
            guideId: guide.value.id,
            cursor: first.value.nextCursor,
        });
        invariant(second.ok, "expected the rest");
        expect(second.value.items.map((c) => c.body)).toEqual(["c25", "c26"]);
        expect(await setBio(db, bob.token, { bio: "bob here" })).toEqual(ok(undefined));
        const profile = await readProfile(db, alice.token, { username: "Bob" });
        invariant(profile.ok, "expected a profile");
        expect(profile.value).toMatchObject({ username: "bob", bio: "bob here", isSelf: false });
        expect(await readProfile(db, alice.token, { username: "nobody" })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
    });
});
