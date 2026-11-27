import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { webContract } from "@lucent/rpc/web";
import { z } from "zod";
import type { Logger } from "../src/base/core/log.ts";
import { queryAll, sql } from "../src/base/db/pool.ts";
import { webProcedures } from "../src/edge/listeners/internal/web-rpc.ts";
import { createShout, listShouts } from "../src/members/community/shouts.ts";
import { createWallComment, listWall } from "../src/members/community/wall.ts";
import { createReport, listReports, resolveReport } from "../src/members/moderation/reports.ts";
import { catalog } from "./authority-fixtures.ts";
import { holdProduct, member, moderator } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const cs2 = ProductId.parse("cs2");
const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";

test("a reported comment is removed by staff, disappears for everyone, leaves a removed line and an audit row", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9301);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const carol = await member(db, rng, "carol@lucent.test", "carol");
        const bad = await createWallComment(db, bob.token, {
            username: "alice",
            body: "buy cheap keys",
        });
        invariant(bad.ok, "expected a comment");
        const report = (who: typeof alice) =>
            createReport(db, who.token, {
                catalog: products,
                kind: "comment",
                targetId: bad.value.id,
                reason: "spam",
                note: "",
            });
        expect(await report(alice)).toEqual(ok(undefined));
        expect(await report(alice)).toEqual(ok(undefined));
        expect(await report(carol)).toEqual(ok(undefined));
        const queue = await listReports(db, { caller: mod.caller, cursor: null });
        invariant(queue.ok, "expected the queue");
        expect(queue.value.items.map((r) => [r.kind, r.excerpt, r.reporter.username])).toEqual([
            ["comment", "buy cheap keys", "alice"],
            ["comment", "buy cheap keys", "carol"],
        ]);
        expect(queue.value.items[0]?.author.username).toBe("bob");
        expect(queue.value.items[0]?.productId).toBeNull();

        const lines: string[] = [];
        const logger: Logger = {
            write: (_level, msg, fields) => lines.push(`${msg} ${fields?.detail}`),
        };
        const auth = await createTestAuthDeps(db, rng);
        const app = mountInternalRpc({
            path: "/rpc",
            peerKey: PEER_KEY,
            procedures: webProcedures,
            createContext: () => Promise.resolve(ok({ catalog: products, auth, logger })),
            onUnhandledError: () => {},
        });
        const client = createRpcClient(webContract, {
            endpointUrl: "http://localhost/rpc",
            peerKey: PEER_KEY,
            fetcher: async (req) => await app.fetch(req),
        });
        const first = queue.value.items[0];
        invariant(first !== undefined, "expected a report");
        expect(
            await client.call(
                "admin.moderation.reports.resolve",
                { id: first.id, outcome: "remove" },
                { session: alice.token },
            ),
        ).toEqual(err({ code: "FORBIDDEN" }));
        expect(lines).toEqual([]);
        expect(
            await client.call(
                "admin.moderation.reports.resolve",
                { id: first.id, outcome: "remove" },
                { session: mod.token },
            ),
        ).toEqual(ok({}));
        expect(lines).toEqual([`removed comment ${bad.value.id}`]);

        // Gone for everyone, the author included.
        for (const who of [alice, bob, carol]) {
            const comments = await listWall(db, who.token, { username: "alice", cursor: null });
            expect(comments).toEqual(ok({ items: [], nextCursor: null }));
        }
        // The other open report on the same comment closed with it.
        expect(await listReports(db, { caller: mod.caller, cursor: null })).toEqual(
            ok({ items: [], nextCursor: null }),
        );
        expect(
            await resolveReport({ db, caller: mod.caller, id: first.id, outcome: "remove" }),
        ).toEqual(err({ code: "NOT_FOUND" }));
        // Nothing was deleted, and the log of who did it is the audit table.
        const rows = await queryAll(
            db,
            z.object({ operation: z.string(), actor: z.string(), kind: z.string().nullable() }),
            sql`select operation, actor_id as actor, target->>'kind' as kind from audit
                where operation like 'community.%' order by id`,
        );
        expect(rows).toEqual(
            ok([{ operation: "community.remove", actor: mod.id, kind: "comment" }]),
        );
        const kept = await queryAll(
            db,
            z.object({ removed: z.boolean(), by: z.string() }),
            sql`select removed_at is not null as removed, removed_by as by from comment`,
        );
        expect(kept).toEqual(ok([{ removed: true, by: mod.id }]));
    });
});

test("dismissing closes one report and removes nothing; a removed shout leaves the feed", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9302);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const shout = await createShout(db, bob.token, {
            catalog: products,
            productId: null,
            body: "fine",
        });
        invariant(shout.ok, "expected a shout");
        const spam = await createShout(db, bob.token, {
            catalog: products,
            productId: null,
            body: "spam",
        });
        invariant(spam.ok, "expected a shout");
        const flag = (targetId: string) =>
            createReport(db, alice.token, {
                catalog: products,
                kind: "shout",
                targetId,
                reason: "other",
                note: "check",
            });
        expect(await flag(shout.value.id)).toEqual(ok(undefined));
        expect(await flag(spam.value.id)).toEqual(ok(undefined));
        const queue = await listReports(db, { caller: mod.caller, cursor: null });
        invariant(queue.ok && queue.value.items.length === 2, "expected two reports");
        const [dismissed, removed] = queue.value.items;
        invariant(dismissed !== undefined && removed !== undefined, "expected both");
        expect(dismissed.excerpt).toBe("fine");
        expect(
            await resolveReport({ db, caller: mod.caller, id: dismissed.id, outcome: "dismiss" }),
        ).toEqual(ok({ removed: null }));
        const feed = () =>
            listShouts(db, alice.token, { catalog: products, productId: null, cursor: null }).then(
                (r) => (r.ok ? r.value.items.map((item) => item.id).sort() : r.error.code),
            );
        expect(await feed()).toEqual([shout.value.id, spam.value.id].sort());

        expect(
            await resolveReport({ db, caller: mod.caller, id: removed.id, outcome: "remove" }),
        ).toEqual(ok({ removed: { kind: "shout", id: spam.value.id } }));
        expect(await feed()).toEqual([shout.value.id]);
    });
});

test("a member can report only what they can see", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9303);
        const holder = await member(db, rng, "holder@lucent.test", "holder");
        const stranger = await member(db, rng, "stranger@lucent.test", "stranger");
        await holdProduct(db, rng, holder.id, "cs2");
        const shout = await createShout(db, holder.token, {
            catalog: products,
            productId: cs2,
            body: "seed news",
        });
        invariant(shout.ok, "expected a shout for the holder");
        const attempt = (token: typeof holder.token, targetId: string) =>
            createReport(db, token, {
                catalog: products,
                kind: "shout",
                targetId,
                reason: "abuse",
                note: "",
            });
        expect(await attempt(stranger.token, shout.value.id)).toEqual(err({ code: "NOT_FOUND" }));
        expect(await attempt(holder.token, "00000000-0000-4000-8000-000000000009")).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        expect(await attempt(holder.token, shout.value.id)).toEqual(ok(undefined));
    });
});
