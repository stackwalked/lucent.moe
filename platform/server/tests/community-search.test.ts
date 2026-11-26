import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { setBlock } from "../src/members/community/blocks.ts";
import { createGuide } from "../src/members/community/guides.ts";
import { setVisibility } from "../src/members/community/profiles.ts";
import { searchCommunity } from "../src/members/community/search.ts";
import { createReport, listReports, resolveReport } from "../src/members/moderation/reports.ts";
import { catalog } from "./authority-fixtures.ts";
import { holdProduct, member, moderator } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const loader = ProductId.parse("lucent-loader");
const cs2 = ProductId.parse("cs2");

test("search finds guides by their words and accounts by username prefix, cut to what the searcher may see", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9501);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice_fox");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const holder = await member(db, rng, "holder@lucent.test", "alfred");
        await holdProduct(db, rng, holder.id, "cs2");
        const write = async (
            who: typeof alice,
            productId: ProductId,
            title: string,
            body: string,
        ) => {
            const made = await createGuide(db, who.token, {
                catalog: products,
                productId,
                title,
                body,
            });
            invariant(made.ok, "expected a guide");
            return made.value.id;
        };
        const aimbot = await write(
            alice,
            loader,
            "Calibrating the aimbot",
            "Tune the smoothing first.",
        );
        await write(bob, loader, "Unrelated", "Nothing about it, except smoothing the curves.");
        const seeded = await write(holder, cs2, "Seed guide", "smoothing for the seed product");
        const removed = await write(bob, loader, "Spam", "smoothing smoothing smoothing");

        const found = (who: typeof alice, q: string) =>
            searchCommunity(db, who.token, { catalog: products, q }).then((r) => {
                invariant(r.ok, "expected results");
                return r.value;
            });

        // The stemmer matches "smoothing" in all three bodies of the products alice may see; a
        // word in a title finds the guide too.
        const smooth = await found(alice, "smoothing");
        expect(smooth.guides.map((g) => g.title).sort()).toEqual([
            "Calibrating the aimbot",
            "Spam",
            "Unrelated",
        ]);
        expect((await found(alice, "aimbot")).guides.map((g) => g.id)).toEqual([aimbot]);
        // An unlisted seed product is not searchable; the holder finds it.
        expect((await found(alice, "seed")).guides).toEqual([]);
        expect((await found(holder, "seed")).guides.map((g) => g.id)).toEqual([seeded]);
        // Usernames by prefix, whatever case, never a tsquery error from what is typed.
        expect((await found(bob, "AL")).accounts.map((a) => a.username)).toEqual([
            "alfred",
            "alice_fox",
        ]);
        expect((await found(bob, "alice f")).accounts.map((a) => a.username)).toEqual([
            "alice_fox",
        ]);
        expect(await found(bob, "!&|:*")).toEqual({ guides: [], accounts: [] });
        expect((await found(bob, "al'); drop table guide; --")).accounts).toEqual([]);

        // Blocks hide both ways, private profiles hide from others, removal hides everywhere.
        expect(await setBlock(db, alice.token, { username: "bob", blocked: true })).toEqual(
            ok(undefined),
        );
        expect((await found(alice, "smoothing")).guides.map((g) => g.id)).toEqual([aimbot]);
        expect((await found(bob, "smoothing")).guides.map((g) => g.id)).not.toContain(aimbot);
        expect((await found(bob, "alice")).accounts).toEqual([]);
        expect(await setBlock(db, alice.token, { username: "bob", blocked: false })).toEqual(
            ok(undefined),
        );
        expect(await setVisibility(db, holder.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect((await found(bob, "alfred")).accounts).toEqual([]);
        expect((await found(holder, "alfred")).accounts.map((a) => a.username)).toEqual(["alfred"]);

        expect(
            await createReport(db, alice.token, {
                catalog: products,
                kind: "guide",
                targetId: removed,
                reason: "spam",
                note: "",
            }),
        ).toEqual(ok(undefined));
        const queue = await listReports(db, { caller: mod.caller, cursor: null });
        invariant(queue.ok && queue.value.items[0] !== undefined, "expected a report");
        expect(
            (
                await resolveReport({
                    db,
                    caller: mod.caller,
                    id: queue.value.items[0].id,
                    outcome: "remove",
                })
            ).ok,
        ).toBe(true);
        expect((await found(bob, "spam")).guides).toEqual([]);
    });
});
