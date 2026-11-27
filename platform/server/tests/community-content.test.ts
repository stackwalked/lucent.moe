import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { readProfile, setBio } from "../src/members/community/profiles.ts";
import { createShout, listShouts } from "../src/members/community/shouts.ts";
import { createWallComment } from "../src/members/community/wall.ts";
import { setRestriction } from "../src/members/moderation/restrictions.ts";
import { catalog } from "./authority-fixtures.ts";
import { holdProduct, member, moderator } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const loader = ProductId.parse("lucent-loader");
const cs2 = ProductId.parse("cs2");

test("a bar in one product closes shouts about it and nothing else", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9201);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        await member(db, rng, "bob@lucent.test", "bob");
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
        expect(
            await createShout(db, alice.token, { catalog: products, productId: loader, body: "x" }),
        ).toEqual(
            err({ code: "POSTING_RESTRICTED", kind: "barred", productId: loader, endsAt: null }),
        );
        // Elsewhere she is free: a shout about no product, a comment on a wall, her own bio.
        expect(
            (
                await createShout(db, alice.token, {
                    catalog: products,
                    productId: null,
                    body: "hello",
                })
            ).ok,
        ).toBe(true);
        expect((await createWallComment(db, alice.token, { username: "bob", body: "hi" })).ok).toBe(
            true,
        );
        expect(await setBio(db, alice.token, { bio: "hi" })).toEqual(ok(undefined));
    });
});

test("a mute closes wall comments and shouts but leaves the profile open", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9202);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        await member(db, rng, "bob@lucent.test", "bob");
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
        expect((await createWallComment(db, alice.token, { username: "bob", body: "c" })).ok).toBe(
            false,
        );
        expect(
            (await createShout(db, alice.token, { catalog: products, productId: null, body: "s" }))
                .ok,
        ).toBe(false);
        expect(await setBio(db, alice.token, { bio: "still here" })).toEqual(ok(undefined));
    });
});

test("shouts show only to members who may see their product", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9203);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const holder = await member(db, rng, "holder@lucent.test", "holder");
        // cs2 is a seed product: listed only for accounts that hold it.
        await holdProduct(db, rng, holder.id, "cs2");
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

test("profiles name their owner", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9204);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        expect(await setBio(db, bob.token, { bio: "bob here" })).toEqual(ok(undefined));
        const profile = await readProfile(db, alice.token, { username: "Bob" });
        invariant(profile.ok, "expected a profile");
        expect(profile.value).toMatchObject({ username: "bob", bio: "bob here", isSelf: false });
        expect(await readProfile(db, alice.token, { username: "nobody" })).toEqual(
            err({ code: "NOT_FOUND" }),
        );
    });
});
