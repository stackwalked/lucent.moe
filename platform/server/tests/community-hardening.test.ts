import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { execute, queryOne, sql } from "../src/base/db/pool.ts";
import { setBlock } from "../src/members/community/blocks.ts";
import { createComment, listComments } from "../src/members/community/comments.ts";
import { exportOwnData } from "../src/members/community/export.ts";
import { createGuide, listGuides } from "../src/members/community/guides.ts";
import { readProfile, setBio } from "../src/members/community/profiles.ts";
import { createShout } from "../src/members/community/shouts.ts";
import { createReport, listReports, resolveReport } from "../src/members/moderation/reports.ts";
import { setRestriction } from "../src/members/moderation/restrictions.ts";
import { catalog } from "./authority-fixtures.ts";
import { member, moderator } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const loader = ProductId.parse("lucent-loader");

test("a reported profile bio is removed from view for everyone, audited, and the owner can write a new one", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9701);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        expect(await setBio(db, bob.token, { bio: "buy cheap keys" })).toEqual(ok(undefined));
        const profile = await readProfile(db, alice.token, { username: "bob" });
        invariant(profile.ok && profile.value.id !== null, "expected a profile with an id");
        expect(
            await createReport(db, alice.token, {
                catalog: products,
                kind: "profile",
                targetId: profile.value.id,
                reason: "spam",
                note: "",
            }),
        ).toEqual(ok(undefined));
        const queue = await listReports(db, { caller: mod.caller, cursor: null });
        invariant(queue.ok && queue.value.items[0] !== undefined, "expected a report");
        expect(queue.value.items[0]).toMatchObject({
            kind: "profile",
            excerpt: "buy cheap keys",
            author: { username: "bob" },
        });
        expect(
            await resolveReport({
                db,
                caller: mod.caller,
                id: queue.value.items[0].id,
                outcome: "remove",
            }),
        ).toEqual(ok({ removed: { kind: "profile", id: profile.value.id } }));
        for (const viewer of [alice, bob]) {
            const seen = await readProfile(db, viewer.token, { username: "bob" });
            invariant(seen.ok, "expected the profile page");
            expect(seen.value.bio).toBe("");
        }
        const audited = await queryOne(
            db,
            z.object({ n: z.coerce.number() }),
            sql`select count(*) as n from audit where operation = 'community.remove' and target->>'kind' = 'profile'`,
        );
        expect(audited).toEqual(ok({ n: 1 }));
        // Reporting it again finds nothing; the owner may write anew unless restricted.
        expect(
            await createReport(db, alice.token, {
                catalog: products,
                kind: "profile",
                targetId: profile.value.id,
                reason: "spam",
                note: "",
            }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        expect(await setBio(db, bob.token, { bio: "hello again" })).toEqual(ok(undefined));
        const again = await readProfile(db, alice.token, { username: "bob" });
        invariant(again.ok, "expected the profile page");
        expect(again.value.bio).toBe("hello again");
        invariant(
            (
                await setRestriction({
                    db,
                    catalog: products,
                    caller: mod.caller,
                    username: "bob",
                    kind: "barred",
                    productId: null,
                    reason: "x",
                    endsAt: null,
                })
            ).ok,
            "expected a restriction",
        );
        expect((await setBio(db, bob.token, { bio: "blocked" })).ok).toBe(false);
    });
});

test("a member cannot report a comment on a guide whose author blocked them, and learns nothing from the id", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9702);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const carol = await member(db, rng, "carol@lucent.test", "carol");
        const guide = await createGuide(db, alice.token, {
            catalog: products,
            productId: loader,
            title: "t",
            body: "b",
        });
        invariant(guide.ok, "expected a guide");
        const comment = await createComment(db, carol.token, {
            catalog: products,
            guideId: guide.value.id,
            body: "c",
        });
        invariant(comment.ok, "expected a comment");
        const report = (id: string) =>
            createReport(db, bob.token, {
                catalog: products,
                kind: "comment",
                targetId: id,
                reason: "spam",
                note: "",
            });
        expect(await report(comment.value.id)).toEqual(ok(undefined));
        expect(await setBlock(db, alice.token, { username: "bob", blocked: true })).toEqual(
            ok(undefined),
        );
        await execute(db, sql`delete from report`);
        const missing = await report("00000000-0000-4000-8000-000000000009");
        expect(await report(comment.value.id)).toEqual(missing);
        expect(missing).toEqual(err({ code: "NOT_FOUND" }));
    });
});

test("volume limits: open reports, posts a minute and guides per product", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9703);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const limit = (name: "reports" | "posts" | "guides") =>
            err({ code: "LIMIT_REACHED", limit: name });

        // Ten posts in the window, then refused; another account is unaffected.
        for (let n = 0; n < 10; n += 1) {
            expect(
                (
                    await createShout(db, alice.token, {
                        catalog: products,
                        productId: null,
                        body: `s${n}`,
                    })
                ).ok,
            ).toBe(true);
        }
        expect(
            await createShout(db, alice.token, {
                catalog: products,
                productId: null,
                body: "one more",
            }),
        ).toEqual(limit("posts"));
        expect(
            (await createShout(db, bob.token, { catalog: products, productId: null, body: "fine" }))
                .ok,
        ).toBe(true);

        // Twenty open reports, then refused; reporting something already reported is not a new one.
        await execute(
            db,
            sql`insert into shout (author_id, body, created_at)
                select ${bob.id}, 'old ' || n, now() - interval '1 hour' from generate_series(1, 21) n`,
        );
        const old = await queryOne(
            db,
            z.object({ ids: z.array(z.uuid()) }),
            sql`select array_agg(id order by body) as ids from shout where body like 'old %'`,
        );
        invariant(old.ok && old.value !== null, "expected the seeded shouts");
        const flag = (id: string) =>
            createReport(db, alice.token, {
                catalog: products,
                kind: "shout",
                targetId: id,
                reason: "spam",
                note: "",
            });
        for (const id of old.value.ids.slice(0, 20)) expect(await flag(id)).toEqual(ok(undefined));
        expect(await flag(old.value.ids[20] ?? "")).toEqual(limit("reports"));
        expect(await flag(old.value.ids[0] ?? "")).toEqual(ok(undefined));

        // Fifty guides in one product, then refused there; removed ones do not count.
        await execute(
            db,
            sql`insert into guide (product_id, author_id, title, body)
                select ${loader}, ${bob.id}, 'g' || n, 'b' from generate_series(1, 50) n`,
        );
        const guide = (token: typeof bob.token) =>
            createGuide(db, token, { catalog: products, productId: loader, title: "x", body: "y" });
        expect(await guide(bob.token)).toEqual(limit("guides"));
        await execute(db, sql`update guide set removed_at = now() where title = 'g1'`);
        expect((await guide(bob.token)).ok).toBe(true);
    });
});

test("the export holds the newest 1,000 rows of a kind and says when it cut one", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9704);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        await execute(
            db,
            sql`insert into shout (author_id, body, created_at)
                select ${alice.id}, 's' || n, now() - make_interval(secs => n) from generate_series(1, 1001) n`,
        );
        const exported = await exportOwnData(db, alice.token);
        invariant(exported.ok, "expected the export");
        expect(exported.value.truncated).toEqual(["shouts"]);
        expect(exported.value.shouts).toHaveLength(1000);
        // The oldest of the 1,001 is the one left out; the rest run oldest first.
        expect(exported.value.shouts[0]?.body).toBe("s1000");
        expect(exported.value.shouts.at(-1)?.body).toBe("s1");
    });
});

test("a cursor naming a row the reader cannot see ends the page instead of ordering by it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9705);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const hidden = await createGuide(db, bob.token, {
            catalog: products,
            productId: loader,
            title: "hidden",
            body: "b",
        });
        invariant(hidden.ok, "expected a guide");
        for (const n of [1, 2]) {
            invariant(
                (
                    await createGuide(db, alice.token, {
                        catalog: products,
                        productId: loader,
                        title: `g${n}`,
                        body: "b",
                    })
                ).ok,
                "expected a guide",
            );
        }
        expect(await setBlock(db, alice.token, { username: "bob", blocked: true })).toEqual(
            ok(undefined),
        );
        const page = await listGuides(db, alice.token, {
            catalog: products,
            productId: loader,
            cursor: hidden.value.id,
        });
        expect(page).toEqual(ok({ items: [], nextCursor: null }));
        const comments = await listComments(db, alice.token, {
            catalog: products,
            guideId: hidden.value.id,
            cursor: null,
        });
        expect(comments).toEqual(err({ code: "NOT_FOUND" }));
    });
});
