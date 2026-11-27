import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId, toHex } from "@lucent/core/scalars";
import { z } from "zod";
import { execute, sql } from "../src/base/db/pool.ts";
import { listMemberProducts } from "../src/delivery/products/products.ts";
import { listReleaseLines } from "../src/delivery/releases/promotion.ts";
import type { ChangelogEntryFields } from "../src/members/record/notes.rules.ts";
import { addNote, deleteNote, listStaffNotes, updateNote } from "../src/members/record/notes.ts";
import { seedRootOnce } from "./auth-fixtures.ts";
import { scalar, steppedUp } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import { createNativeHarness, entitledMember, publishRelease } from "./native-fixtures.ts";

const CS2 = ProductId.parse("cs2");
const INVALID = err({ code: "INVALID_ENTRY" });

const hex = toHex;

function entry(over: Partial<ChangelogEntryFields>): ChangelogEntryFields {
    return {
        subject: "product",
        productId: CS2,
        version: "0.8.3-alpha.1",
        title: null,
        added: ["a thing"],
        changed: [],
        fixed: [],
        body: "",
        releaseId: null,
        ...over,
    };
}

test("an entry names one release; its version is what members and staff read for that release", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(28_001);
        const harness = await createNativeHarness(db, rng);
        const caller = await steppedUp(db, await seedRootOnce(db, rng));
        const member = await entitledMember(harness, {
            email: "linked@lucent.test",
            channels: ["alpha"],
        });
        const first = await publishRelease(db, rng, { product: "cs2", channel: "alpha" });
        const loader = await publishRelease(db, rng, {
            product: "lucent-loader",
            channel: "stable",
        });
        const products = harness.catalog;
        const names = (releaseId: Uint8Array, over: Partial<ChangelogEntryFields> = {}) =>
            entry({ releaseId: hex(releaseId), ...over });

        const added = await addNote(db, { caller, catalog: products, fields: names(first.id) });
        invariant(added.ok, "the entry naming the release is added");

        // One entry per release; the subject must be the release's; a version is required.
        expect(await addNote(db, { caller, catalog: products, fields: names(first.id) })).toEqual(
            INVALID,
        );
        expect(
            await addNote(db, {
                caller,
                catalog: products,
                fields: names(loader.id),
            }),
        ).toEqual(INVALID);
        expect(
            await addNote(db, {
                caller,
                catalog: products,
                fields: names(loader.id, { subject: "loader", productId: null }),
            }),
        ).toMatchObject({ ok: true });
        expect(
            await addNote(db, {
                caller,
                catalog: products,
                fields: names(first.id, { version: null, title: "x" }),
            }),
        ).toEqual(INVALID);

        // A member on alpha sees the version of the release current for them.
        const read = async () => {
            const listed = await listMemberProducts(db, {
                catalog: products,
                sessionToken: member.browserSession,
            });
            invariant(listed.ok, "products list");
            const cs2 = listed.value.find((product) => product.productId === CS2);
            return cs2?.channels.find((c) => c.channel === "alpha")?.release?.version;
        };
        expect(await read()).toBe("0.8.3-alpha.1");

        // A newer release without an entry is current now: no version, not the old one.
        const second = await publishRelease(db, rng, { product: "cs2", channel: "alpha" });
        expect(await read()).toBeNull();

        // Staff see each seal's version, and the choosable releases: the unnamed ones, plus the
        // ones the listed entries name.
        const lines = await listReleaseLines(db, { catalog: products, caller });
        invariant(lines.ok, "release lines read");
        const alpha = lines.value.find(
            (line) => line.productId === CS2 && line.channel === "alpha",
        );
        expect(alpha?.seals.map((seal) => seal.version)).toEqual([null]);
        const listed = await listStaffNotes(db, { caller });
        invariant(listed.ok, "staff list entries");
        expect(listed.value.releases.map((r) => [r.id, r.entryId !== null])).toEqual(
            expect.arrayContaining([
                [hex(second.id), false],
                [hex(first.id), true],
            ]),
        );
        expect(listed.value.changelog.find((row) => row.id === added.value.id)?.releaseId).toBe(
            hex(first.id),
        );

        // Moving the entry to the other release frees the first.
        expect(
            await updateNote(db, {
                caller,
                catalog: products,
                id: added.value.id,
                fields: names(second.id),
            }),
        ).toMatchObject({ ok: true });
        expect(await read()).toBe("0.8.3-alpha.1");
        const freed = await listStaffNotes(db, { caller });
        invariant(freed.ok, "staff list entries");
        expect(freed.value.releases.find((r) => r.id === hex(first.id))?.entryId).toBeNull();
    });
});

test("deleting a release leaves its entry standing with no release", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(28_002);
        const harness = await createNativeHarness(db, rng);
        const caller = await steppedUp(db, await seedRootOnce(db, rng));
        const old = await publishRelease(db, rng, { product: "cs2", channel: "alpha" });
        await publishRelease(db, rng, { product: "cs2", channel: "alpha" });
        const added = await addNote(db, {
            caller,
            catalog: harness.catalog,
            fields: entry({ releaseId: hex(old.id) }),
        });
        invariant(added.ok, "the entry is added");

        for (const statement of [
            sql`delete from release_seal where release_id = ${old.id}`,
            sql`delete from release where id = ${old.id}`,
        ]) {
            const deleted = await execute(db, statement);
            invariant(deleted.ok, "the release is deleted");
        }
        const row = await scalar(
            db,
            z.string(),
            sql`select coalesce(encode(release_id, 'hex'), 'none') || ' ' || version as value
                from changelog_entry where id = ${added.value.id}::uuid`,
        );
        expect(row).toBe("none 0.8.3-alpha.1");
        expect((await deleteNote(db, { caller, id: added.value.id })).ok).toBe(true);
    });
});

test("the table refuses an entry that names a release without a version, and a second entry for a release", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(28_003);
        await createNativeHarness(db, rng);
        const release = await publishRelease(db, rng, { product: "cs2", channel: "alpha" });
        const insert = (version: string | null) =>
            execute(
                db,
                sql`insert into changelog_entry
                        (subject, product_id, version, title, body, release_id, published_at, updated_at)
                    values ('product', 'cs2', ${version}, 'x', 'text', ${release.id},
                            now(), now())`,
            );
        expect((await insert(null)).ok).toBe(false);
        expect((await insert("1")).ok).toBe(true);
        expect((await insert("2")).ok).toBe(false);
    });
});
