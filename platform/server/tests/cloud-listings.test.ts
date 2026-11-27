import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { type AccountId, type BearerToken, newEntitlementId, RoleId } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { webContract } from "@lucent/rpc/web";
import { z } from "zod";
import { type Db, execute, queryAll, queryOne, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { createItem } from "../src/delivery/cloud/items.ts";
import { webProcedures } from "../src/edge/listeners/internal/web-rpc.ts";
import { setBlock } from "../src/members/community/blocks.ts";
import { createReport, resolveReport } from "../src/members/moderation/reports.ts";
import { setRestriction } from "../src/members/moderation/restrictions.ts";
import { memberSession } from "./auth-fixtures.ts";
import {
    catalog,
    grantRole,
    product,
    seedAccount,
    seedRole,
    steppedUp,
    waitForLockWaiters,
} from "./authority-fixtures.ts";
import { NO_LOG } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const cs2 = product("cs2");
const p = { productId: cs2.id };
const limits = { maxItems: 10, maxVersionBytes: 100, maxStoredBytes: 5_000, maxVersionsPerItem: 8 };
const peerKey = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
const missing = err({ code: "NOT_FOUND" });
const forbidden = err({ code: "FORBIDDEN" });

async function world(seed: number, body: (w: Awaited<ReturnType<typeof build>>) => Promise<void>) {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        await body(await build(db, seed));
    });
}

async function build(db: Db, seed: number) {
    const rng = createSeededRng(seed);
    const auth = await createTestAuthDeps(db, rng);
    const app = mountInternalRpc({
        path: "/rpc",
        peerKey,
        procedures: webProcedures,
        createContext: () =>
            Promise.resolve(ok({ auth, catalog: catalog(), cloudLimits: limits, logger: NO_LOG })),
        onUnhandledError: () => {},
    });
    const client = createRpcClient(webContract, {
        endpointUrl: "http://localhost/rpc",
        peerKey,
        fetcher: (req) => Promise.resolve(app.fetch(req)),
    });
    const member = async (name: string, entitled = true) => {
        const id = await seedAccount(db, rng, `${name}@cloud.test`);
        const set = await execute(db, sql`update account set username = ${name} where id = ${id}`);
        invariant(set.ok, "username set");
        if (entitled) await grant(id);
        const session = await memberSession(auth, id);
        return { id, token: session, call: { session } };
    };
    const grant = async (accountId: AccountId) => {
        const id = newEntitlementId(rng);
        await execute(
            db,
            sql`insert into entitlement (id, account_id, valid_from)
                values (${id}, ${accountId}, now() - interval '1 hour')`,
        );
        await execute(
            db,
            sql`insert into entitlement_product (entitlement_id, product_id, features, channels)
                values (${id}, ${p.productId}, '"*"'::jsonb, '{stable}')`,
        );
    };
    const item = async (
        accountId: AccountId,
        kind: "config" | "inventory" | "script",
        name: string,
        content?: Uint8Array,
    ) => {
        const made = await withTx(db, (tx) =>
            createItem(tx, {
                ...p,
                accountId,
                limits,
                kind,
                name,
                bytes: content ?? new TextEncoder().encode(`${name}-v1`),
            }),
        );
        invariant(made.ok, "seeded item");
        return made.value.itemId;
    };
    const staff = async (name: string) => {
        const roleId = RoleId.parse(`role_${name}`);
        await seedRole(db, { id: roleId, rank: 5, permissions: ["moderation:remove"] });
        const who = await member(name);
        await grantRole(db, { accountId: who.id, roleId });
        return who;
    };
    return { db, rng, auth, client, member, grant, item, staff };
}

type World = Awaited<ReturnType<typeof build>>;

async function listed(w: World, who: { call: { session: BearerToken } }, input = {}) {
    const reply = await w.client.call("cloud.listings.list", { ...p, ...input }, who.call);
    invariant(reply.ok, `expected a page, got ${JSON.stringify(reply)}`);
    return reply.value.items;
}

test("a config is listed at once, seen by another entitled member, added once, and the copy does not follow updates", async () => {
    await world(19101, async (w) => {
        const owner = await w.member("owner");
        const buyer = await w.member("buyer");
        const itemId = await w.item(owner.id, "config", "my config");

        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "a good one" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const again = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "twice" },
            owner.call,
        );
        expect(again).toEqual({ ok: false, error: { code: "ALREADY_LISTED" } });

        const seen = await listed(w, buyer);
        expect(
            seen.map((row) => [row.name, row.kind, row.summary, row.owner.username, row.added]),
        ).toEqual([["my config", "config", "a good one", "owner", false]]);
        // Without a product: every product the viewer is entitled to.
        const wide = await w.client.call("cloud.listings.list", {}, buyer.call);
        invariant(wide.ok, "expected a page");
        expect(wide.value.items.map((row) => row.productId)).toEqual([p.productId]);

        const added = await w.client.call(
            "cloud.listings.add",
            { listingId: created.value.listingId },
            buyer.call,
        );
        invariant(added.ok, "expected a copy");
        expect(
            await w.client.call(
                "cloud.listings.add",
                { listingId: created.value.listingId },
                buyer.call,
            ),
        ).toEqual({ ok: false, error: { code: "ALREADY_ADDED" } });
        expect((await listed(w, buyer)).map((row) => row.added)).toEqual([true]);
        const mine = await w.client.call("cloud.items.list", p, buyer.call);
        invariant(mine.ok, "expected items");
        expect(mine.value).toEqual([
            {
                itemId: added.value.itemId,
                revision: 1,
                name: "my config",
                kind: "config",
                source: { listingId: created.value.listingId, owner: "owner" },
            },
        ]);

        // The owner renames the item and re-pins: the listing moves, the copy stays.
        expect(
            await w.client.call(
                "cloud.items.rename",
                { ...p, itemId, base: 1, name: "renamed" },
                owner.call,
            ),
        ).toEqual(ok({ revision: 2, conflict: false }));
        expect(
            await w.client.call(
                "cloud.listings.update",
                { listingId: created.value.listingId },
                owner.call,
            ),
        ).toEqual(ok({}));
        expect((await listed(w, buyer)).map((row) => row.name)).toEqual(["renamed"]);
        const copy = await w.client.call("cloud.items.list", p, buyer.call);
        invariant(copy.ok, "expected items");
        expect(copy.value.map((row) => [row.name, row.revision])).toEqual([["my config", 1]]);

        // `mine` shows the owner their own listing.
        const own = await w.client.call("cloud.listings.mine", p, owner.call);
        invariant(own.ok, "expected the owner's listings");
        expect(own.value.map((row) => [row.name, row.state, row.pending])).toEqual([
            ["renamed", "listed", false],
        ]);
        expect(await w.client.call("cloud.listings.mine", p, buyer.call)).toEqual(ok([]));
    });
});

test("without an entitlement a member can neither see, list nor add", async () => {
    await world(19102, async (w) => {
        const owner = await w.member("owner");
        const outsider = await w.member("outsider", false);
        const itemId = await w.item(owner.id, "config", "cfg");
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");

        expect(await w.client.call("cloud.listings.list", p, outsider.call)).toEqual(missing);
        expect(await w.client.call("cloud.listings.list", {}, outsider.call)).toEqual(
            ok({ items: [], nextCursor: null }),
        );
        expect(
            await w.client.call(
                "cloud.listings.add",
                { listingId: created.value.listingId },
                outsider.call,
            ),
        ).toEqual(missing);
        // Having no cloud there, they cannot list anything either.
        expect(
            await w.client.call(
                "cloud.listings.create",
                { ...p, itemId, summary: "" },
                outsider.call,
            ),
        ).toEqual(missing);
    });
});

test("blocks either way, a tombstone and a suspended owner leave listings out, and the owner filter follows the profile", async () => {
    await world(19103, async (w) => {
        const owner = await w.member("owner");
        const blocker = await w.member("blocker");
        const blocked = await w.member("blocked");
        const bystander = await w.member("bystander");
        const private1 = await w.member("shy");
        const itemId = await w.item(owner.id, "config", "cfg");
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const shyItem = await w.item(private1.id, "inventory", "shy things");
        invariant(
            (
                await w.client.call(
                    "cloud.listings.create",
                    { ...p, itemId: shyItem, summary: "" },
                    private1.call,
                )
            ).ok,
            "expected a listing",
        );

        expect(await setBlock(w.db, blocker.token, { username: "owner", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await setBlock(w.db, owner.token, { username: "blocked", blocked: true })).toEqual(
            ok(undefined),
        );
        for (const viewer of [blocker, blocked]) {
            expect((await listed(w, viewer)).map((row) => row.owner.username)).toEqual(["shy"]);
            expect(
                await w.client.call(
                    "cloud.listings.add",
                    { listingId: created.value.listingId },
                    viewer.call,
                ),
            ).toEqual(missing);
        }
        expect((await listed(w, bystander, { owner: "owner" })).map((row) => row.name)).toEqual([
            "cfg",
        ]);
        expect(await listed(w, blocker, { owner: "owner" })).toEqual([]);

        // A private profile has no listings page.
        expect(
            await execute(
                w.db,
                sql`insert into profile (account_id, bio, visibility) values (${private1.id}, '', 'private')`,
            ),
        ).toEqual({ ok: true, value: 1 });
        expect(await listed(w, bystander, { owner: "shy" })).toEqual([]);
        expect((await listed(w, private1, { owner: "shy" })).map((row) => row.name)).toEqual([
            "shy things",
        ]);

        // Suspended owners and tombstones are left out and cannot be added from.
        expect(
            await execute(
                w.db,
                sql`update account set status = 'suspended' where id = ${owner.id}`,
            ),
        ).toEqual({ ok: true, value: 1 });
        expect(await listed(w, bystander, { owner: "owner" })).toEqual([]);
        expect(
            await w.client.call(
                "cloud.listings.add",
                { listingId: created.value.listingId },
                bystander.call,
            ),
        ).toEqual(missing);
        expect(
            await execute(w.db, sql`update account set status = 'active' where id = ${owner.id}`),
        ).toEqual({ ok: true, value: 1 });
        const stripped = await withTx(w.db, async (tx) => {
            const allowed = await execute(
                tx,
                sql`select set_config('lucent.username_rename', 'on', true)`,
            );
            if (!allowed.ok) return allowed;
            return await execute(
                tx,
                sql`update account set username = null where id = ${owner.id}`,
            );
        });
        expect(stripped).toEqual({ ok: true, value: 1 });
        expect((await listed(w, bystander)).map((row) => row.name)).toEqual(["shy things"]);
    });
});

test("a muted, barred or suspended account cannot list", async () => {
    await world(19104, async (w) => {
        const mod = await w.staff("mod");
        const muted = await w.member("muted");
        const barred = await w.member("barred");
        const suspended = await w.member("suspended");
        const modCaller = await steppedUp(w.db, mod.id);
        for (const [username, kind] of [
            ["muted", "muted"],
            ["barred", "barred"],
        ] as const) {
            const set = await setRestriction({
                db: w.db,
                catalog: catalog(),
                caller: modCaller,
                username,
                kind,
                productId: null,
                reason: "spam",
                endsAt: null,
            });
            invariant(set.ok, "expected a restriction");
        }
        for (const [who, kind] of [
            [muted, "muted"],
            [barred, "barred"],
        ] as const) {
            const itemId = await w.item(who.id, "config", `${kind} cfg`);
            expect(
                await w.client.call(
                    "cloud.listings.create",
                    { ...p, itemId, summary: "" },
                    who.call,
                ),
            ).toEqual({
                ok: false,
                error: { code: "POSTING_RESTRICTED", kind, productId: null, endsAt: null },
            });
        }
        const itemId = await w.item(suspended.id, "config", "cfg");
        expect(
            await execute(
                w.db,
                sql`update account set status = 'suspended' where id = ${suspended.id}`,
            ),
        ).toEqual({ ok: true, value: 1 });
        const refused = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "" },
            suspended.call,
        );
        expect(refused.ok).toBe(false);
    });
});

test("a script is invisible until staff approve it, and an update keeps the approved snapshot visible", async () => {
    await world(19105, async (w) => {
        const owner = await w.member("owner");
        const buyer = await w.member("buyer");
        const mod = await w.staff("mod");
        const itemId = await w.item(owner.id, "script", "overlay v1");
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "runs code" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const id = created.value.listingId;

        expect(await listed(w, buyer)).toEqual([]);
        expect(await w.client.call("cloud.listings.add", { listingId: id }, buyer.call)).toEqual(
            missing,
        );
        const own = await w.client.call("cloud.listings.mine", p, owner.call);
        invariant(own.ok, "expected the owner's listings");
        expect(own.value.map((row) => [row.state, row.pending])).toEqual([["pending", true]]);

        // What waits shows to staff only, and only staff with the permission approve.
        const waiting = await w.client.call(
            "admin.cloud.listings.list",
            { state: "pending", cursor: null },
            mod.call,
        );
        invariant(waiting.ok, "expected the queue");
        expect(waiting.value.items.map((row) => [row.name, row.first, row.owner.username])).toEqual(
            [["overlay v1", true, "owner"]],
        );
        expect(
            await w.client.call(
                "admin.cloud.listings.list",
                { state: "pending", cursor: null },
                buyer.call,
            ),
        ).toEqual(forbidden);
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: 1 },
                buyer.call,
            ),
        ).toEqual(forbidden);
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: 1 },
                owner.call,
            ),
        ).toEqual(forbidden);
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: 1 },
                mod.call,
            ),
        ).toEqual(ok({}));
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: 1 },
                mod.call,
            ),
        ).toEqual(missing);
        expect((await listed(w, buyer)).map((row) => row.name)).toEqual(["overlay v1"]);

        // An update: the listing is listed at v1 and pending at v2; others still get v1.
        expect(
            await w.client.call(
                "cloud.items.rename",
                { ...p, itemId, base: 1, name: "overlay v2" },
                owner.call,
            ),
        ).toEqual(ok({ revision: 2, conflict: false }));
        expect(await w.client.call("cloud.listings.update", { listingId: id }, owner.call)).toEqual(
            ok({}),
        );
        expect((await listed(w, buyer)).map((row) => row.name)).toEqual(["overlay v1"]);
        const added = await w.client.call("cloud.listings.add", { listingId: id }, buyer.call);
        invariant(added.ok, "expected a copy of the approved snapshot");
        const copies = await queryAll(
            w.db,
            z.object({ name: z.string() }),
            sql`select name from cloud_version where account_id = ${buyer.id} and item_id = ${added.value.itemId}`,
        );
        invariant(copies.ok, "expected the copy's version");
        expect(copies.value).toEqual([{ name: "overlay v1" }]);
        const second = await w.client.call(
            "admin.cloud.listings.list",
            { state: "pending", cursor: null },
            mod.call,
        );
        invariant(second.ok, "expected the queue");
        expect(second.value.items.map((row) => [row.name, row.first])).toEqual([
            ["overlay v2", false],
        ]);
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: 2 },
                mod.call,
            ),
        ).toEqual(ok({}));
        expect((await listed(w, buyer)).map((row) => row.name)).toEqual(["overlay v2"]);

        // The pinned revisions are kept out of the item's version window while pinned.
        const audit = await queryAll(
            w.db,
            z.object({ operation: z.string() }),
            sql`select operation from audit where operation like 'cloud.listing.%' order by at, id`,
        );
        invariant(audit.ok, "expected the audit rows");
        expect(audit.value.map((row) => row.operation)).toEqual([
            "cloud.listing.approve",
            "cloud.listing.approve",
        ]);
    });
});

test("an owner removes their own listing, staff with moderation:remove remove anyone's, and a removed one pins nothing", async () => {
    await world(19106, async (w) => {
        const owner = await w.member("owner");
        const other = await w.member("other");
        const mod = await w.staff("mod");
        const a = await w.item(owner.id, "config", "a");
        const b = await w.item(owner.id, "config", "b");
        const first = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId: a, summary: "" },
            owner.call,
        );
        const second = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId: b, summary: "" },
            owner.call,
        );
        invariant(first.ok && second.ok, "expected listings");

        expect(
            await w.client.call(
                "cloud.listings.remove",
                { listingId: first.value.listingId },
                other.call,
            ),
        ).toEqual(missing);
        expect(
            await w.client.call(
                "admin.cloud.listings.remove",
                { listingId: first.value.listingId },
                other.call,
            ),
        ).toEqual(forbidden);
        expect(
            await w.client.call(
                "cloud.listings.remove",
                { listingId: first.value.listingId },
                owner.call,
            ),
        ).toEqual(ok({}));
        expect((await listed(w, other)).map((row) => row.name)).toEqual(["b"]);
        expect(
            await w.client.call(
                "admin.cloud.listings.remove",
                { listingId: second.value.listingId },
                mod.call,
            ),
        ).toEqual(ok({}));
        expect(
            await w.client.call(
                "admin.cloud.listings.remove",
                { listingId: second.value.listingId },
                mod.call,
            ),
        ).toEqual(missing);
        expect(await listed(w, other)).toEqual([]);
        const pins = await queryOne(
            w.db,
            z.object({ pinned: z.coerce.number() }),
            sql`select count(*) as pinned from cloud_listing where revision is not null or pending_revision is not null`,
        );
        expect(pins).toEqual(ok({ pinned: 0 }));
        const audit = await queryAll(
            w.db,
            z.object({ operation: z.string() }),
            sql`select operation from audit where operation like 'cloud.listing.%'`,
        );
        invariant(audit.ok, "expected the audit rows");
        expect(audit.value.map((row) => row.operation)).toEqual(["cloud.listing.remove"]);

        // The item can be listed again once its listing is removed.
        expect(
            (
                await w.client.call(
                    "cloud.listings.create",
                    { ...p, itemId: a, summary: "again" },
                    owner.call,
                )
            ).ok,
        ).toBe(true);
    });
});

test("the widened read filters by kind and text, and a deleted item takes its listing while copies stay", async () => {
    await world(19107, async (w) => {
        const owner = await w.member("owner");
        const buyer = await w.member("buyer");
        const cfg = await w.item(owner.id, "config", "alpha config");
        const inv = await w.item(owner.id, "inventory", "beta inventory");
        const listing = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId: cfg, summary: "for 100% of cases" },
            owner.call,
        );
        invariant(listing.ok, "expected a listing");
        invariant(
            (
                await w.client.call(
                    "cloud.listings.create",
                    { ...p, itemId: inv, summary: "" },
                    owner.call,
                )
            ).ok,
            "expected a listing",
        );
        expect((await listed(w, buyer, { kind: "inventory" })).map((row) => row.name)).toEqual([
            "beta inventory",
        ]);
        expect((await listed(w, buyer, { text: "ALPHA" })).map((row) => row.name)).toEqual([
            "alpha config",
        ]);
        expect((await listed(w, buyer, { text: "100%" })).map((row) => row.name)).toEqual([
            "alpha config",
        ]);
        expect(await listed(w, buyer, { text: "%" })).toHaveLength(1);

        const added = await w.client.call(
            "cloud.listings.add",
            { listingId: listing.value.listingId },
            buyer.call,
        );
        invariant(added.ok, "expected a copy");
        expect(
            await w.client.call("cloud.items.delete", { ...p, itemId: cfg }, owner.call),
        ).toEqual(ok({}));
        expect((await listed(w, buyer)).map((row) => row.name)).toEqual(["beta inventory"]);
        const copy = await w.client.call("cloud.items.list", p, buyer.call);
        invariant(copy.ok, "expected items");
        expect(copy.value.map((row) => [row.name, row.source])).toEqual([["alpha config", null]]);
    });
});

test("a listing can be reported, and removing it through the report takes it down", async () => {
    await world(19108, async (w) => {
        const owner = await w.member("owner");
        const reporter = await w.member("reporter");
        const mod = await w.staff("mod");
        const itemId = await w.item(owner.id, "config", "spam");
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "buy now" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        expect(
            await createReport(w.db, reporter.token, {
                catalog: catalog(),
                kind: "listing",
                targetId: created.value.listingId,
                reason: "spam",
                note: "",
            }),
        ).toEqual(ok(undefined));
        const open = await queryOne(
            w.db,
            z.object({ id: z.uuid() }),
            sql`select id from report where state = 'open'`,
        );
        invariant(open.ok && open.value !== null, "expected a report");
        const resolved = await resolveReport({
            db: w.db,
            caller: await steppedUp(w.db, mod.id),
            id: open.value.id,
            outcome: "remove",
        });
        expect(resolved).toEqual(ok({ removed: { kind: "listing", id: created.value.listingId } }));
        expect(await listed(w, reporter)).toEqual([]);
        const state = await queryOne(
            w.db,
            z.object({ state: z.string() }),
            sql`select state from cloud_listing where id = ${created.value.listingId}::uuid`,
        );
        expect(state).toEqual(ok({ state: "removed" }));
    });
});

async function addVersion(
    w: World,
    accountId: AccountId,
    itemId: string,
    revision: number,
    text: string,
) {
    const added = await execute(
        w.db,
        sql`insert into cloud_version (account_id, product_id, item_id, revision, name, bytes)
            values (${accountId}, ${p.productId}, ${itemId}::bigint, ${revision}, ${text},
                    ${new TextEncoder().encode(text)})`,
    );
    invariant(added.ok, "expected a new version");
}

test("staff read the script waiting, and beside it the listed one for an update; only moderation:remove reads it", async () => {
    await world(19110, async (w) => {
        const owner = await w.member("owner");
        const mod = await w.staff("mod");
        const itemId = await w.item(owner.id, "script", "overlay");
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "runs code" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const id = created.value.listingId;

        expect(
            await w.client.call("admin.cloud.listings.get", { listingId: id }, owner.call),
        ).toEqual(forbidden);
        const first = await w.client.call("admin.cloud.listings.get", { listingId: id }, mod.call);
        invariant(first.ok, "expected the waiting script");
        expect(first.value.pending).toEqual({
            revision: 1,
            content: "overlay-v1",
            size: 10,
            escaped: false,
        });
        expect(first.value.listed).toBeNull();
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: first.value.pending.revision },
                mod.call,
            ),
        ).toEqual(ok({}));
        // Approved, nothing waits.
        expect(
            await w.client.call("admin.cloud.listings.get", { listingId: id }, mod.call),
        ).toEqual(missing);

        await addVersion(w, owner.id, itemId, 2, "<b>second</b>");
        expect(await w.client.call("cloud.listings.update", { listingId: id }, owner.call)).toEqual(
            ok({}),
        );
        const update = await w.client.call("admin.cloud.listings.get", { listingId: id }, mod.call);
        invariant(update.ok, "expected the update");
        expect(update.value.pending).toEqual({
            revision: 2,
            content: "<b>second</b>",
            size: 13,
            escaped: false,
        });
        expect(update.value.listed).toEqual({
            revision: 1,
            content: "overlay-v1",
            size: 10,
            escaped: false,
        });
    });
});

test("a script staff cannot read as text is shown as not shown with its size, and cannot be approved", async () => {
    await world(19113, async (w) => {
        const owner = await w.member("owner");
        const mod = await w.staff("mod");
        const buyer = await w.member("buyer");
        const bad = new Uint8Array([0x61, 0xc3, 0x28]);
        const itemId = await w.item(owner.id, "script", "broken", bad);
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const id = created.value.listingId;
        const read = await w.client.call("admin.cloud.listings.get", { listingId: id }, mod.call);
        invariant(read.ok, "expected the waiting script");
        expect(read.value.pending).toEqual({ revision: 1, content: null, size: 3, escaped: false });
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: 1 },
                mod.call,
            ),
        ).toEqual(err({ code: "UNREADABLE_CONTENT" }));
        expect(await listed(w, buyer)).toEqual([]);
    });
});

test("staff approve the revision they read: one pinned since is stale, before or while the approval waits", async () => {
    await world(19111, async (w) => {
        const owner = await w.member("owner");
        const buyer = await w.member("buyer");
        const mod = await w.staff("mod");
        const itemId = await w.item(owner.id, "script", "overlay");
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const id = created.value.listingId;
        const stale = err({ code: "STALE_REVISION" });

        await addVersion(w, owner.id, itemId, 2, "unseen");
        expect(await w.client.call("cloud.listings.update", { listingId: id }, owner.call)).toEqual(
            ok({}),
        );
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: 1 },
                mod.call,
            ),
        ).toEqual(stale);
        expect(await listed(w, buyer)).toEqual([]);

        // Staff read revision 2; the owner pins 3 while the approval waits on the row.
        await addVersion(w, owner.id, itemId, 3, "swapped");
        const racing: ReturnType<typeof w.client.call>[] = [];
        let parked = false;
        const gate = await withTx(w.db, async (tx) => {
            const held = await execute(
                tx,
                sql`select 1 from cloud_listing where id = ${id}::uuid for update`,
            );
            invariant(held.ok, "the gate holds the listing");
            racing.push(
                w.client.call(
                    "admin.cloud.listings.approve",
                    { listingId: id, revision: 2 },
                    mod.call,
                ),
            );
            parked = await waitForLockWaiters(w.db, 1);
            const pinned = await execute(
                tx,
                sql`update cloud_listing set pending_revision = 3 where id = ${id}::uuid`,
            );
            invariant(pinned.ok, "the gate re-pins");
            return ok(undefined);
        });
        expect(gate.ok).toBe(true);
        expect(parked).toBe(true);
        expect(await racing[0]).toEqual(stale);
        expect(await listed(w, buyer)).toEqual([]);
        expect(
            await w.client.call(
                "admin.cloud.listings.approve",
                { listingId: id, revision: 3 },
                mod.call,
            ),
        ).toEqual(ok({}));
        expect((await listed(w, buyer)).map((row) => row.name)).toEqual(["swapped"]);
    });
});

test("a copy's source owner reads as null when the owner is blocked, suspended or gone", async () => {
    await world(19112, async (w) => {
        const owner = await w.member("owner");
        const buyer = await w.member("buyer");
        const itemId = await w.item(owner.id, "config", "cfg");
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const added = await w.client.call(
            "cloud.listings.add",
            { listingId: created.value.listingId },
            buyer.call,
        );
        invariant(added.ok, "expected a copy");
        const sourceOwner = async () => {
            const items = await w.client.call("cloud.items.list", p, buyer.call);
            invariant(items.ok, "expected items");
            return items.value[0]?.source?.owner;
        };
        expect(await sourceOwner()).toBe("owner");

        expect(await setBlock(w.db, buyer.token, { username: "owner", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await sourceOwner()).toBeNull();
        expect(await setBlock(w.db, buyer.token, { username: "owner", blocked: false })).toEqual(
            ok(undefined),
        );
        expect(await setBlock(w.db, owner.token, { username: "buyer", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await sourceOwner()).toBeNull();
        expect(await setBlock(w.db, owner.token, { username: "buyer", blocked: false })).toEqual(
            ok(undefined),
        );
        expect(await sourceOwner()).toBe("owner");

        await execute(w.db, sql`update account set status = 'suspended' where id = ${owner.id}`);
        expect(await sourceOwner()).toBeNull();
        await execute(w.db, sql`update account set status = 'active' where id = ${owner.id}`);
        expect(await sourceOwner()).toBe("owner");
    });
});

test("the browse pages by the cursor row's own key: equal timestamps never skip, a changed row does not end the list, and a bad cursor is refused", async () => {
    await world(19113, async (w) => {
        const buyer = await w.member("buyer");
        const owners = [await w.member("one"), await w.member("two"), await w.member("three")];
        for (const owner of owners) {
            for (let n = 0; n < 9; n++) {
                const itemId = await w.item(owner.id, "config", `cfg ${n}`);
                const created = await w.client.call(
                    "cloud.listings.create",
                    { ...p, itemId, summary: "" },
                    owner.call,
                );
                invariant(created.ok, "expected a listing");
            }
        }
        // Every listing updated in one microsecond that a millisecond cursor would cut.
        expect(
            await execute(
                w.db,
                sql`update cloud_listing set updated_at = timestamptz '2026-01-01 00:00:00.123456+00'`,
            ),
        ).toEqual({ ok: true, value: 27 });
        const order = await queryAll(
            w.db,
            z.object({ id: z.uuid() }),
            sql`select id from cloud_listing order by updated_at desc, id desc`,
        );
        invariant(order.ok, "expected the order");

        const first = await w.client.call("cloud.listings.list", p, buyer.call);
        invariant(first.ok && first.value.nextCursor !== null, "expected a second page");
        expect(first.value.items.length).toBe(25);
        // The last row of the page is taken down before the next page is asked for.
        const lastRow = first.value.items.at(-1);
        invariant(lastRow !== undefined, "expected a last row");
        expect(
            await execute(
                w.db,
                sql`update cloud_listing set state = 'removed', revision = null, removed_at = now()
                    where id = ${lastRow.id}::uuid`,
            ),
        ).toEqual({ ok: true, value: 1 });
        const second = await w.client.call(
            "cloud.listings.list",
            { ...p, cursor: first.value.nextCursor },
            buyer.call,
        );
        invariant(second.ok, "expected the second page");
        expect(second.value.nextCursor).toBeNull();
        const all = [...first.value.items, ...second.value.items].map((row) => row.id);
        expect(all).toEqual(order.value.map((row) => row.id));

        const refused = err({ code: "INVALID_CURSOR" });
        for (const cursor of ["x", lastRow.id, "eyJhIjoxfQ"]) {
            expect(
                await w.client.call("cloud.listings.list", { ...p, cursor }, buyer.call),
            ).toEqual(refused);
        }
    });
});

// --- a listing's own page ---

const text = (value: string) => new TextEncoder().encode(value);

test("a listing's page shows the listed snapshot, the description and whether you hold a copy", async () => {
    await world(19201, async (w) => {
        const owner = await w.member("owner");
        const buyer = await w.member("buyer");
        const itemId = await w.item(
            owner.id,
            "config",
            "my config",
            text('{"a":1,"b":[true,null]}'),
        );
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "a good one", description: "first line\nsecond line" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const id = created.value.listingId;

        const seen = await w.client.call("cloud.listings.get", { listingId: id }, buyer.call);
        invariant(seen.ok, "expected the page");
        expect(seen.value).toMatchObject({
            id,
            productId: p.productId,
            name: "my config",
            kind: "config",
            summary: "a good one",
            description: "first line\nsecond line",
            owner: { username: "owner" },
            mine: false,
            added: false,
            copy: null,
            size: 23,
        });
        // Compact JSON is laid out; what is shown parses to what is installed.
        expect(seen.value.content).toBe(
            ["{", '  "a": 1,', '  "b": [', "    true,", "    null", "  ]", "}"].join("\n"),
        );
        expect(seen.value.listedAt).toBeLessThanOrEqual(seen.value.updatedAt);

        const added = await w.client.call("cloud.listings.add", { listingId: id }, buyer.call);
        invariant(added.ok, "expected a copy");
        const after = await w.client.call("cloud.listings.get", { listingId: id }, buyer.call);
        invariant(after.ok, "expected the page");
        expect(after.value).toMatchObject({ added: true, copy: { itemId: added.value.itemId } });
        const own = await w.client.call("cloud.listings.get", { listingId: id }, owner.call);
        invariant(own.ok, "expected the owner's page");
        expect(own.value).toMatchObject({ mine: true, added: false });
    });
});

test("what a page shows of the bytes: text as it is, a script's source whole, anything else not at all", async () => {
    await world(19202, async (w) => {
        const owner = await w.member("owner");
        const mod = await w.staff("mod");
        const buyer = await w.member("buyer");
        const page = async (
            kind: "config" | "inventory" | "script",
            name: string,
            bytes: Uint8Array,
        ) => {
            const itemId = await w.item(owner.id, kind, name, bytes);
            const created = await w.client.call(
                "cloud.listings.create",
                { ...p, itemId, summary: "" },
                owner.call,
            );
            invariant(created.ok, "expected a listing");
            if (kind === "script") {
                const approved = await w.client.call(
                    "admin.cloud.listings.approve",
                    { listingId: created.value.listingId, revision: 1 },
                    mod.call,
                );
                invariant(approved.ok, "expected an approval");
            }
            const read = await w.client.call(
                "cloud.listings.get",
                { listingId: created.value.listingId },
                buyer.call,
            );
            invariant(read.ok, "expected the page");
            return read.value;
        };
        const source = "local x = 1\n\tprint(x)\n";
        expect((await page("script", "src", text(source))).content).toBe(source);
        // Laid-out JSON and other text are left as written.
        const laidOut = '{\n  "a": 1\n}';
        expect((await page("config", "pretty", text(laidOut))).content).toBe(laidOut);
        expect((await page("inventory", "words", text("not json at all"))).content).toBe(
            "not json at all",
        );
        // Big integers survive: compact JSON is laid out only when it round-trips exactly.
        const big = '{"id":12345678901234567890}';
        expect((await page("config", "big", text(big))).content).toBe(big);
        // Opaque: bytes that are not text, or hold control characters, are not shown; their size is.
        const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80]);
        expect(await page("config", "binary", binary)).toMatchObject({ content: null, size: 5 });
        expect(await page("inventory", "nul", text("a\u0000b"))).toMatchObject({
            content: null,
            size: 3,
        });
        // Characters that disguise code are shown as text, and the page says so.
        expect(await page("script", "sneaky", text("a‮b﻿c"))).toMatchObject({
            content: "a\\u{202E}b\\u{FEFF}c",
            escaped: true,
        });
    });
});

test("who may read a listing's page: entitled members, not blocked, not a gone or suspended owner, and only what is listed", async () => {
    await world(19203, async (w) => {
        const owner = await w.member("owner");
        const buyer = await w.member("buyer");
        const outsider = await w.member("outsider", false);
        const blocker = await w.member("blocker");
        const blocked = await w.member("blocked");
        const mod = await w.staff("mod");
        const itemId = await w.item(owner.id, "config", "cfg");
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "" },
            owner.call,
        );
        invariant(created.ok, "expected a listing");
        const id = created.value.listingId;
        const get = (who: { call: { session: BearerToken } }, listingId = id) =>
            w.client.call("cloud.listings.get", { listingId }, who.call);

        expect((await get(buyer)).ok).toBe(true);
        expect(await get(outsider)).toEqual(missing);
        expect(await get(buyer, "00000000-0000-4000-8000-000000000009")).toEqual(missing);

        expect(await setBlock(w.db, blocker.token, { username: "owner", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await setBlock(w.db, owner.token, { username: "blocked", blocked: true })).toEqual(
            ok(undefined),
        );
        expect(await get(blocker)).toEqual(missing);
        expect(await get(blocked)).toEqual(missing);

        expect(
            await execute(
                w.db,
                sql`update account set status = 'suspended' where id = ${owner.id}`,
            ),
        ).toEqual({ ok: true, value: 1 });
        expect(await get(buyer)).toEqual(missing);
        expect(
            await execute(w.db, sql`update account set status = 'active' where id = ${owner.id}`),
        ).toEqual({ ok: true, value: 1 });
        const stripped = await withTx(w.db, async (tx) => {
            const allowed = await execute(
                tx,
                sql`select set_config('lucent.username_rename', 'on', true)`,
            );
            if (!allowed.ok) return allowed;
            return await execute(
                tx,
                sql`update account set username = null where id = ${owner.id}`,
            );
        });
        expect(stripped).toEqual({ ok: true, value: 1 });
        expect(await get(buyer)).toEqual(missing);

        // A script not yet approved has no page for anyone, its owner included; once approved it
        // does, and an update waiting for staff never shows: the last approved snapshot does.
        const other = await w.member("author");
        const script = await w.item(other.id, "script", "overlay", text("v1 source"));
        const scripted = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId: script, summary: "" },
            other.call,
        );
        invariant(scripted.ok, "expected a listing");
        const sid = scripted.value.listingId;
        expect(await get(buyer, sid)).toEqual(missing);
        expect(await get(other, sid)).toEqual(missing);
        expect(
            (
                await w.client.call(
                    "admin.cloud.listings.approve",
                    { listingId: sid, revision: 1 },
                    mod.call,
                )
            ).ok,
        ).toBe(true);
        const v1 = await get(buyer, sid);
        invariant(v1.ok, "expected the approved page");
        expect(v1.value.content).toBe("v1 source");
        const appended = await w.client.call(
            "cloud.items.restore",
            { ...p, itemId: script, base: 1, revision: 1 },
            other.call,
        );
        invariant(appended.ok, "expected a new revision");
        expect(
            await w.client.call("cloud.listings.update", { listingId: sid }, other.call),
        ).toEqual(ok({}));
        const still = await get(buyer, sid);
        invariant(still.ok, "expected the page");
        expect(still.value.content).toBe("v1 source");
    });
});

test("a description is 0 to 2,000 characters, set on create and update, and changing it alone never sends a script back to staff", async () => {
    await world(19204, async (w) => {
        const owner = await w.member("owner");
        const mod = await w.staff("mod");
        const itemId = await w.item(owner.id, "script", "tool", text("source"));
        const tooLong = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "", description: "x".repeat(2_001) },
            owner.call,
        );
        expect(tooLong.ok).toBe(false);
        const created = await w.client.call(
            "cloud.listings.create",
            { ...p, itemId, summary: "", description: "x".repeat(2_000) },
            owner.call,
        );
        invariant(created.ok, "expected a listing at the limit");
        const id = created.value.listingId;
        expect(
            (
                await w.client.call(
                    "admin.cloud.listings.approve",
                    { listingId: id, revision: 1 },
                    mod.call,
                )
            ).ok,
        ).toBe(true);
        // Staff read the description beside the waiting script.
        expect(
            (
                await w.client.call(
                    "cloud.listings.update",
                    { listingId: id, description: "new words\nand a line" },
                    owner.call,
                )
            ).ok,
        ).toBe(true);
        const mine = await w.client.call("cloud.listings.mine", p, owner.call);
        invariant(mine.ok, "expected the owner's listings");
        expect(mine.value.map((row) => [row.state, row.pending])).toEqual([["listed", false]]);
        expect(
            await w.client.call(
                "cloud.listings.update",
                { listingId: id, description: "x".repeat(2_001) },
                owner.call,
            ),
        ).toMatchObject({ ok: false });
        const page = await w.client.call("cloud.listings.get", { listingId: id }, owner.call);
        invariant(page.ok, "expected the page");
        expect(page.value.description).toBe("new words\nand a line");
        // A new revision does need approval, as before; staff see the description with it.
        const appended = await w.client.call(
            "cloud.items.restore",
            { ...p, itemId, base: 1, revision: 1 },
            owner.call,
        );
        invariant(appended.ok, "expected a new revision");
        expect(await w.client.call("cloud.listings.update", { listingId: id }, owner.call)).toEqual(
            ok({}),
        );
        const waiting = await w.client.call("cloud.listings.mine", p, owner.call);
        invariant(waiting.ok, "expected the owner's listings");
        expect(waiting.value.map((row) => row.pending)).toEqual([true]);
        const review = await w.client.call("admin.cloud.listings.get", { listingId: id }, mod.call);
        invariant(review.ok, "expected the review read");
        expect(review.value.description).toBe("new words\nand a line");
    });
});
