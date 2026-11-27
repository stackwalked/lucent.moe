import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { EpochMs, newOperationId, RoleId } from "@lucent/core/scalars";
import { z } from "zod";
import { execute, queryOne, sql, toTimestamptz } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { resolveMembers } from "../src/edge/discord/sync.ts";
import { listRoles } from "../src/identity/authority/reads.ts";
import { upsertRole } from "../src/identity/authority/writers.ts";
import { setBlock } from "../src/members/community/blocks.ts";
import {
    readProfile,
    readShows,
    type ShowKey,
    setBio,
    setShows,
    setVisibility,
} from "../src/members/community/profiles.ts";
import {
    catalog,
    dbNow,
    seedAccount,
    seedRole,
    seedStaff,
    steppedUp,
} from "./authority-fixtures.ts";
import { holdProduct, member, moderator, sessionFor } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
async function readAs(
    db: Parameters<typeof readProfile>[0],
    token: Parameters<typeof readProfile>[1],
    username: string,
) {
    return await readProfile(db, token, {
        username,
        present: () => false,
        catalog: products,
    });
}

async function addInviteEdge(db: Parameters<typeof execute>[0], inviter: string, invitee: string) {
    const inserted = await execute(
        db,
        sql`insert into invite (inviter_id, created_at, expires_at, redeemed_at, invitee_id)
            values (${inviter}, now(), now() + interval '7 days', now(), ${invitee})`,
    );
    expect(inserted).toEqual({ ok: true, value: 1 });
}

test("profile opt-outs hide only their own field from other members", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18101);
        const owner = await member(db, rng, "owner@lucent.test", "owner");
        const viewer = await member(db, rng, "viewer@lucent.test", "viewer");
        const inviter = await member(db, rng, "inviter@lucent.test", "inviter");
        const invitee = await member(db, rng, "invitee@lucent.test", "invitee");
        expect(await setBio(db, owner.token, { bio: "owner bio" })).toEqual(ok(undefined));
        await addInviteEdge(db, inviter.id, owner.id);
        await addInviteEdge(db, owner.id, invitee.id);
        await holdProduct(db, rng, owner.id, "cs2");
        await holdProduct(db, rng, viewer.id, "cs2");
        expect(
            await execute(
                db,
                sql`insert into connector_discord_link (account_id, discord_user_id, linked_at, username)
                    values (${owner.id}, ${"123456789012345678"}, now(), ${"ownerdiscord"})`,
            ),
        ).toEqual({ ok: true, value: 1 });

        const visible = await readAs(db, viewer.token, "owner");
        invariant(visible.ok, "expected viewer to read the public profile");
        expect(visible.value.invitedBy).toBe("inviter");
        expect(visible.value.invited).toEqual(["invitee"]);
        expect(visible.value.products).toEqual(["Counter-Strike 2"]);
        expect(typeof visible.value.lastSeen).toBe("number");
        expect(visible.value.discord).toBe("ownerdiscord");

        type ProfileFields = {
            readonly invitedBy: string | null;
            readonly invited: readonly string[] | null;
            readonly products: readonly string[] | null;
            readonly lastSeen: unknown;
            readonly discord: string | null;
        };
        const cases: readonly { key: ShowKey; read: (value: ProfileFields) => unknown }[] = [
            { key: "invitedBy", read: (value) => value.invitedBy },
            { key: "invited", read: (value) => value.invited },
            { key: "products", read: (value) => value.products },
            { key: "lastSeen", read: (value) => value.lastSeen },
            { key: "discord", read: (value) => value.discord },
        ];
        for (const item of cases) {
            expect(await setShows(db, owner.token, { [item.key]: false })).toEqual(ok(undefined));
            const hidden = await readAs(db, viewer.token, "owner");
            invariant(hidden.ok, "expected viewer to read the public profile");
            expect(item.read(hidden.value)).toBeNull();
            const own = await readAs(db, owner.token, "owner");
            invariant(own.ok, "expected owner to read their profile");
            expect(item.read(own.value)).not.toBeNull();
            expect(await setShows(db, owner.token, { [item.key]: true })).toEqual(ok(undefined));
        }
    });
});

test("privacy shows are independent and default to shown without a profile row", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18102);
        const owner = await member(db, rng, "shows@lucent.test", "shows");
        expect(await readShows(db, owner.token)).toEqual(
            ok({
                invitedBy: true,
                invited: true,
                products: true,
                lastSeen: true,
                discord: true,
                wall: true,
            }),
        );
        expect(await setShows(db, owner.token, { discord: false })).toEqual(ok(undefined));
        expect(await setShows(db, owner.token, { products: false, lastSeen: false })).toEqual(
            ok(undefined),
        );
        expect(await readShows(db, owner.token)).toEqual(
            ok({
                invitedBy: true,
                invited: true,
                products: false,
                lastSeen: false,
                discord: false,
                wall: true,
            }),
        );
    });
});

test("private and blocked profiles keep the new fields hidden from other members", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18103);
        const owner = await member(db, rng, "private-owner@lucent.test", "privateowner");
        const viewer = await member(db, rng, "private-viewer@lucent.test", "privateviewer");
        expect(await setBio(db, owner.token, { bio: "private bio" })).toEqual(ok(undefined));
        expect(await setVisibility(db, owner.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect(await readAs(db, viewer.token, "privateowner")).toEqual(err({ code: "NOT_FOUND" }));
        const own = await readAs(db, owner.token, "privateowner");
        invariant(own.ok, "owner still reads a private profile");
        expect(own.value.bio).toBe("private bio");

        expect(await setVisibility(db, owner.token, { visibility: "members" })).toEqual(
            ok(undefined),
        );
        expect(
            await setBlock(db, owner.token, { username: "privateviewer", blocked: true }),
        ).toEqual(ok(undefined));
        expect(await readAs(db, viewer.token, "privateowner")).toEqual(err({ code: "NOT_FOUND" }));
        expect(await readAs(db, owner.token, "privateviewer")).toEqual(err({ code: "NOT_FOUND" }));
        expect(
            await setBlock(db, owner.token, { username: "privateviewer", blocked: false }),
        ).toEqual(ok(undefined));
        expect(
            await setBlock(db, viewer.token, { username: "privateowner", blocked: true }),
        ).toEqual(ok(undefined));
        expect(await readAs(db, viewer.token, "privateowner")).toEqual(err({ code: "NOT_FOUND" }));
        expect(await readAs(db, owner.token, "privateviewer")).toEqual(err({ code: "NOT_FOUND" }));
    });
});

test("tombstones never appear as invited by or invited members", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18104);
        const owner = await member(db, rng, "tree-owner@lucent.test", "treeowner");
        const viewer = await member(db, rng, "tree-viewer@lucent.test", "treeviewer");
        const inviter = await member(db, rng, "tree-inviter@lucent.test", "treeinviter");
        const invitee = await member(db, rng, "tree-invitee@lucent.test", "treeinvitee");
        expect(await setBio(db, owner.token, { bio: "tree" })).toEqual(ok(undefined));
        await addInviteEdge(db, inviter.id, owner.id);
        await addInviteEdge(db, owner.id, invitee.id);
        const before = await readAs(db, viewer.token, "treeowner");
        invariant(before.ok, "expected lineage before tombstones");
        expect(before.value.invitedBy).toBe("treeinviter");
        expect(before.value.invited).toEqual(["treeinvitee"]);

        for (const account of [inviter, invitee]) {
            const stripped = await withTx(db, async (tx) => {
                const allowed = await execute(
                    tx,
                    sql`select set_config('lucent.username_rename', 'on', true)`,
                );
                if (!allowed.ok) return allowed;
                return await execute(
                    tx,
                    sql`update account set deleted_at = now(), email = null, username = null,
                           suspended_at_deletion = false
                        where id = ${account.id}`,
                );
            });
            expect(stripped).toEqual({ ok: true, value: 1 });
        }
        const after = await readAs(db, viewer.token, "treeowner");
        invariant(after.ok, "expected lineage read after tombstones");
        expect(after.value.invitedBy).toBeNull();
        expect(after.value.invited ?? []).not.toContain("treeinvitee");
    });
});

test("member numbers are concurrent-safe, increasing, and never reused by tombstones", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18105);
        const first = await seedAccount(db, rng, "number-first@lucent.test");
        const [second, third] = await Promise.all([
            seedAccount(db, rng, "number-second@lucent.test"),
            seedAccount(db, rng, "number-third@lucent.test"),
        ]);
        const numberOf = async (accountId: string) => {
            const row = await queryOne(
                db,
                z.object({ memberNo: z.coerce.number() }),
                sql`select member_no as "memberNo" from account where id = ${accountId}`,
            );
            invariant(row.ok && row.value !== null, "expected a member number");
            return row.value.memberNo;
        };
        const firstNo = await numberOf(first);
        const secondNo = await numberOf(second);
        const thirdNo = await numberOf(third);
        expect(new Set([firstNo, secondNo, thirdNo]).size).toBe(3);
        expect(secondNo).toBeGreaterThan(firstNo);
        expect(thirdNo).toBeGreaterThan(firstNo);

        const stripped = await withTx(db, async (tx) => {
            const allowed = await execute(
                tx,
                sql`select set_config('lucent.username_rename', 'on', true)`,
            );
            if (!allowed.ok) return allowed;
            return await execute(
                tx,
                sql`update account set deleted_at = now(), email = null, username = null,
                       suspended_at_deletion = false where id = ${second}`,
            );
        });
        expect(stripped).toEqual({ ok: true, value: 1 });
        expect(await numberOf(second)).toBe(secondNo);
        const fourth = await seedAccount(db, rng, "number-fourth@lucent.test");
        const fourthNo = await numberOf(fourth);
        expect(fourthNo).not.toBe(secondNo);
        expect(fourthNo).toBeGreaterThan(Math.max(firstNo, secondNo, thirdNo));
    });
});

test("role label colours round-trip, require roles manage, and reject unknown colours", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18106);
        const managerRole = await seedRole(db, {
            id: "role_manager",
            rank: 50,
            permissions: ["roles:manage"],
        });
        const managerId = await seedStaff(db, rng, {
            email: "role-manager@lucent.test",
            roleId: managerRole,
        });
        const caller = await steppedUp(db, managerId);
        const roleId = RoleId.parse("role_labeled");
        const saved = await upsertRole({
            db,
            catalog: products,
            caller,
            operationId: newOperationId(rng),
            roleId,
            name: "Labeled",
            rank: 10,
            permissions: [],
            labelColor: "violet",
            channelGrants: [],
        });
        invariant(saved.ok, "expected role save");
        const listed = await listRoles(db, { caller });
        invariant(listed.ok, "expected role list");
        expect(listed.value.find((role) => role.roleId === roleId)?.labelColor).toBe("violet");

        const strangerId = await seedAccount(db, rng, "role-stranger@lucent.test");
        const stranger = await steppedUp(db, strangerId);
        const denied = await upsertRole({
            db,
            catalog: products,
            caller: stranger,
            operationId: newOperationId(rng),
            roleId: RoleId.parse("role_denied"),
            name: "Denied",
            rank: 10,
            permissions: [],
            labelColor: "pink",
            channelGrants: [],
        });
        expect(denied.ok).toBe(false);

        const invalid = await upsertRole({
            db,
            catalog: products,
            caller,
            operationId: newOperationId(rng),
            roleId: RoleId.parse("role_invalid_color"),
            name: "Invalid color",
            rank: 10,
            permissions: [],
            labelColor: "ultraviolet",
            channelGrants: [],
        });
        expect(invalid.ok).toBe(false);
    });
});

test("the member-facing role label uses the lowest ranked unexpired coloured role", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18107);
        const owner = await member(db, rng, "label-owner@lucent.test", "labelowner");
        const viewer = await member(db, rng, "label-viewer@lucent.test", "labelviewer");
        expect(await setBio(db, owner.token, { bio: "labels" })).toEqual(ok(undefined));
        const expired = await seedRole(db, { id: "role_expired", rank: 1, permissions: [] });
        const visible = await seedRole(db, { id: "role_visible", rank: 5, permissions: [] });
        const plain = await seedRole(db, { id: "role_plain", rank: 0, permissions: [] });
        for (const [roleId, color] of [
            [expired, "pink"],
            [visible, "aqua"],
        ] as const) {
            expect(
                await execute(db, sql`update role set label_color = ${color} where id = ${roleId}`),
            ).toEqual({
                ok: true,
                value: 1,
            });
        }
        const now = await dbNow(db);
        await execute(
            db,
            sql`insert into account_role (account_id, role_id, expires_at)
                values (${owner.id}, ${expired}, ${toTimestamptz(EpochMs.parse(now - 1000))}::timestamptz)`,
        );
        await execute(
            db,
            sql`insert into account_role (account_id, role_id) values (${owner.id}, ${visible})`,
        );
        await execute(
            db,
            sql`insert into account_role (account_id, role_id) values (${owner.id}, ${plain})`,
        );
        const labelled = await readAs(db, viewer.token, "labelowner");
        invariant(labelled.ok, "expected labelled profile");
        expect(labelled.value.role).toEqual({ name: "role_visible", color: "aqua" });

        expect(
            await execute(db, sql`update role set label_color = null where id = ${visible}`),
        ).toEqual({
            ok: true,
            value: 1,
        });
        const unlabelled = await readAs(db, viewer.token, "labelowner");
        invariant(unlabelled.ok, "expected unlabelled profile");
        expect(unlabelled.value.role).toBeNull();
    });
});

test("discord role sync refreshes the stored username when the connector provides it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18109);
        const owner = await member(db, rng, "discord-owner@lucent.test", "discordowner");
        const discordId = "123456789012345679";
        expect(
            await execute(
                db,
                sql`insert into connector_discord_link (account_id, discord_user_id, linked_at, username)
                    values (${owner.id}, ${discordId}, now(), ${"oldhandle"})`,
            ),
        ).toEqual({ ok: true, value: 1 });
        const resolved = await resolveMembers(db, [discordId], { [discordId]: "newhandle" });
        expect(resolved.ok).toBe(true);
        const stored = await queryOne(
            db,
            z.object({ username: z.string() }),
            sql`select username from connector_discord_link where account_id = ${owner.id}`,
        );
        invariant(stored.ok && stored.value !== null, "expected a discord link");
        expect(stored.value.username).toBe("newhandle");
        const withoutNames = await resolveMembers(db, [discordId]);
        expect(withoutNames.ok).toBe(true);
        const unchanged = await queryOne(
            db,
            z.object({ username: z.string() }),
            sql`select username from connector_discord_link where account_id = ${owner.id}`,
        );
        invariant(unchanged.ok && unchanged.value !== null, "expected a discord link");
        expect(unchanged.value.username).toBe("newhandle");
    });
});

async function suspend(db: Parameters<typeof execute>[0], accountId: string) {
    expect(
        await execute(db, sql`update account set status = 'suspended' where id = ${accountId}`),
    ).toEqual({ ok: true, value: 1 });
}

test("invited by and invited name only accounts the viewer may meet: public, active and unblocked", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18110);
        const owner = await member(db, rng, "lineage-owner@lucent.test", "lineageowner");
        const viewer = await member(db, rng, "lineage-viewer@lucent.test", "lineageviewer");
        const inviter = await member(db, rng, "lineage-inviter@lucent.test", "lineageinviter");
        const open = await member(db, rng, "lineage-open@lucent.test", "lineageopen");
        const hidden = await member(db, rng, "lineage-hidden@lucent.test", "lineagehidden");
        const blocked = await member(db, rng, "lineage-blocked@lucent.test", "lineageblocked");
        const blocker = await member(db, rng, "lineage-blocker@lucent.test", "lineageblocker");
        const away = await member(db, rng, "lineage-away@lucent.test", "lineageaway");
        await addInviteEdge(db, inviter.id, owner.id);
        for (const invitee of [open, hidden, blocked, blocker, away]) {
            await addInviteEdge(db, owner.id, invitee.id);
        }
        const names = async () => {
            const seen = await readAs(db, viewer.token, "lineageowner");
            invariant(seen.ok, "expected the profile");
            return { by: seen.value.invitedBy, invited: seen.value.invited };
        };
        expect((await names()).invited).toEqual([
            "lineageopen",
            "lineagehidden",
            "lineageblocked",
            "lineageblocker",
            "lineageaway",
        ]);

        expect(await setVisibility(db, hidden.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect(
            await setBlock(db, viewer.token, { username: "lineageblocked", blocked: true }),
        ).toEqual(ok(undefined));
        expect(
            await setBlock(db, blocker.token, { username: "lineageviewer", blocked: true }),
        ).toEqual(ok(undefined));
        await suspend(db, away.id);
        expect((await names()).invited).toEqual(["lineageopen"]);

        expect((await names()).by).toBe("lineageinviter");
        expect(await setVisibility(db, inviter.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect((await names()).by).toBeNull();
        expect(await setVisibility(db, inviter.token, { visibility: "members" })).toEqual(
            ok(undefined),
        );
        expect(
            await setBlock(db, inviter.token, { username: "lineageviewer", blocked: true }),
        ).toEqual(ok(undefined));
        expect((await names()).by).toBeNull();
        expect(
            await setBlock(db, inviter.token, { username: "lineageviewer", blocked: false }),
        ).toEqual(ok(undefined));
        await suspend(db, inviter.id);
        expect((await names()).by).toBeNull();
    });
});

test("a suspended account's profile is missing to members, and shown to staff reading accounts", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18111);
        const target = await member(db, rng, "suspended@lucent.test", "suspendedone");
        const viewer = await member(db, rng, "suspended-viewer@lucent.test", "suspendedviewer");
        const reader = await seedRole(db, {
            id: "role_reader",
            rank: 5,
            permissions: ["accounts:read"],
        });
        const staffId = await seedStaff(db, rng, { email: "reader@lucent.test", roleId: reader });
        const staffToken = await sessionFor(db, rng, staffId);
        expect(await setBio(db, target.token, { bio: "still here" })).toEqual(ok(undefined));
        expect((await readAs(db, viewer.token, "suspendedone")).ok).toBe(true);

        await suspend(db, target.id);
        expect(await readAs(db, viewer.token, "suspendedone")).toEqual(err({ code: "NOT_FOUND" }));
        expect((await readAs(db, staffToken, "suspendedone")).ok).toBe(true);
    });
});

test("an unlisted product is not named on a profile to a member who cannot see it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18112);
        const owner = await member(db, rng, "named-owner@lucent.test", "namedowner");
        const holder = await member(db, rng, "named-holder@lucent.test", "namedholder");
        const stranger = await member(db, rng, "named-stranger@lucent.test", "namedstranger");
        await holdProduct(db, rng, owner.id, "cs2");
        await holdProduct(db, rng, holder.id, "cs2");
        const productsOf = async (token: Parameters<typeof readAs>[1]) => {
            const seen = await readAs(db, token, "namedowner");
            invariant(seen.ok, "expected the profile");
            return seen.value.products;
        };
        // cs2 is a seed product: listed only to members who hold it.
        expect(await productsOf(holder.token)).toEqual(["Counter-Strike 2"]);
        expect(await productsOf(stranger.token)).toEqual([]);
        expect(await productsOf(owner.token)).toEqual(["Counter-Strike 2"]);
    });
});

test("a profile staff removed reads empty to others until a new bio lifts it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18113);
        const mod = await moderator(db, rng, "removal-mod@lucent.test");
        const owner = await member(db, rng, "removal-owner@lucent.test", "removalowner");
        const viewer = await member(db, rng, "removal-viewer@lucent.test", "removalviewer");
        expect(await setBio(db, owner.token, { bio: "rude" })).toEqual(ok(undefined));
        expect(
            await execute(
                db,
                sql`update profile set removed_at = now(), removed_by = ${mod.id}
                    where account_id = ${owner.id}`,
            ),
        ).toEqual({ ok: true, value: 1 });
        const removed = async () => {
            const row = await queryOne(
                db,
                z.object({ removed: z.boolean() }),
                sql`select removed_at is not null as removed from profile
                    where account_id = ${owner.id}`,
            );
            invariant(row.ok && row.value !== null, "expected the profile row");
            return row.value.removed;
        };
        expect(await removed()).toBe(true);
        const seen = await readAs(db, viewer.token, "removalowner");
        invariant(seen.ok, "expected the profile");
        expect(seen.value.bio).toBe("");

        expect(await setBio(db, owner.token, { bio: "sorry" })).toEqual(ok(undefined));
        expect(await removed()).toBe(false);
    });
});
