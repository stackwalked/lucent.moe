import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { webContract } from "@lucent/rpc/web";
import { z } from "zod";
import { type Db, execute, sql } from "../src/db/pool.ts";
import {
    addNote,
    closeIssue,
    deleteNote,
    listStaffNotes,
    updateNote,
} from "../src/record/notes.ts";
import { listPublicChangelog, readPublicStatus } from "../src/record/status.ts";
import { seedRootOnce } from "./auth-fixtures.ts";
import { catalog, scalar, seedRole, seedStaff, steppedUp } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import { liveCatalog } from "./record-fixtures.ts";

const CS2 = ProductId.parse("cs2");

const auditCount = (db: Db, operation: string) =>
    scalar(
        db,
        z.coerce.number(),
        sql`select count(*) as value from audit where operation = ${operation}`,
    );

test("a known issue and a changelog entry staff add appear publicly, and a closed issue stops showing as open", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const products = liveCatalog();
        const caller = await steppedUp(db, await seedRootOnce(db, createSeededRng(11_201)));
        const issue = await addNote(db, {
            caller,
            catalog: products,
            kind: "issue",
            fields: { productId: CS2, title: "crosshair flickers", body: "on <b>4:3</b>" },
        });
        invariant(issue.ok, "the issue is added");
        const entry = await addNote(db, {
            caller,
            catalog: products,
            kind: "changelog",
            fields: { productId: null, title: "faster sign-in", body: "" },
        });
        invariant(entry.ok, "the entry is added");

        const shown = await readPublicStatus(db, { catalog: products });
        invariant(shown.ok, "the status reads");
        expect(shown.value.issues).toMatchObject([
            {
                id: issue.value.id,
                productId: CS2,
                title: "crosshair flickers",
                body: "on <b>4:3</b>",
            },
        ]);
        expect(shown.value.changelog).toMatchObject([{ id: entry.value.id, productId: null }]);
        const changelog = await listPublicChangelog(db, { catalog: products });
        invariant(changelog.ok, "the changelog reads");
        expect(changelog.value.entries.map((e) => e.id)).toEqual([entry.value.id]);

        expect(
            await updateNote(db, {
                caller,
                catalog: products,
                kind: "issue",
                id: issue.value.id,
                fields: { productId: CS2, title: "crosshair flickers on 4:3", body: "" },
            }),
        ).toEqual({ ok: true, value: undefined });
        expect((await closeIssue(db, { caller, id: issue.value.id })).ok).toBe(true);
        // Closing it again changes nothing and records nothing.
        expect((await closeIssue(db, { caller, id: issue.value.id })).ok).toBe(true);
        const after = await readPublicStatus(db, { catalog: products });
        invariant(after.ok, "the status reads");
        expect(after.value.issues).toEqual([]);
        const staff = await listStaffNotes(db, { caller });
        invariant(staff.ok, "staff list them");
        expect(staff.value.issues).toMatchObject([
            {
                id: issue.value.id,
                title: "crosshair flickers on 4:3",
                closedAt: expect.any(Number),
            },
        ]);

        expect((await deleteNote(db, { caller, kind: "changelog", id: entry.value.id })).ok).toBe(
            true,
        );
        const emptied = await listPublicChangelog(db, { catalog: products });
        invariant(emptied.ok, "the changelog reads");
        expect(emptied.value.entries).toEqual([]);
        expect(await deleteNote(db, { caller, kind: "changelog", id: entry.value.id })).toEqual(
            err({ code: "NOT_FOUND" }),
        );

        for (const [operation, count] of [
            ["known_issue.add", 1],
            ["known_issue.update", 1],
            ["known_issue.close", 1],
            ["changelog.add", 1],
            ["changelog.delete", 1],
        ] as const) {
            expect(await auditCount(db, operation)).toBe(count);
        }
    });
});

test("without releases:promote every write is refused and nothing is written", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_202);
        const products = liveCatalog();
        const root = await steppedUp(db, await seedRootOnce(db, rng));
        const issue = await addNote(db, {
            caller: root,
            catalog: products,
            kind: "issue",
            fields: { productId: null, title: "one", body: "" },
        });
        invariant(issue.ok, "root adds an issue");
        const roleId = await seedRole(db, {
            id: "role_facts",
            rank: 10,
            permissions: ["facts:promote"],
        });
        const caller = await steppedUp(
            db,
            await seedStaff(db, rng, { email: "facts@lucent.test", roleId }),
        );
        const fields = { productId: null, title: "two", body: "" };
        const forbidden = err({ code: "FORBIDDEN" });
        for (const kind of ["issue", "changelog"] as const) {
            expect(await addNote(db, { caller, catalog: products, kind, fields })).toEqual(
                forbidden,
            );
            expect(
                await updateNote(db, {
                    caller,
                    catalog: products,
                    kind,
                    id: issue.value.id,
                    fields,
                }),
            ).toEqual(forbidden);
            expect(await deleteNote(db, { caller, kind, id: issue.value.id })).toEqual(forbidden);
        }
        expect(await closeIssue(db, { caller, id: issue.value.id })).toEqual(forbidden);
        expect(await listStaffNotes(db, { caller })).toEqual(forbidden);
        expect(
            await scalar(
                db,
                z.coerce.number(),
                sql`select count(*) as value from audit where actor_id = ${caller.accountId}`,
            ),
        ).toBe(0);
        const staff = await listStaffNotes(db, { caller: root });
        invariant(staff.ok, "root lists them");
        expect(staff.value.issues).toMatchObject([{ title: "one", closedAt: null }]);
        expect(staff.value.changelog).toEqual([]);
    });
});

test("an issue or entry naming a seed product is in no public output, and an unknown product is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const products = catalog();
        expect(products.get(CS2)?.state).toBe("seed");
        const caller = await steppedUp(db, await seedRootOnce(db, createSeededRng(11_203)));
        for (const kind of ["issue", "changelog"] as const) {
            const added = await addNote(db, {
                caller,
                catalog: products,
                kind,
                fields: { productId: CS2, title: "unannounced", body: "" },
            });
            expect(added.ok).toBe(true);
            expect(
                await addNote(db, {
                    caller,
                    catalog: products,
                    kind,
                    fields: { productId: ProductId.parse("nope"), title: "x", body: "" },
                }),
            ).toEqual(err({ code: "UNKNOWN_PRODUCT" }));
        }
        const status = await readPublicStatus(db, { catalog: products });
        const changelog = await listPublicChangelog(db, { catalog: products });
        invariant(status.ok && changelog.ok, "the public reads answer");
        for (const output of [status.value, changelog.value]) {
            expect(JSON.stringify(output)).not.toContain("cs2");
            expect(JSON.stringify(output)).not.toContain("unannounced");
        }
    });
});

test("titles and bodies are bounded plain text", () => {
    const add = webContract["admin.issues.add"].input;
    const entry = webContract["admin.changelog.add"].input;
    const accepts = (input: unknown, schema = add) => schema.safeParse(input).success;
    const fields = { productId: null, title: "one", body: "line\nline\ttab" };
    expect(accepts(fields)).toBe(true);
    expect(accepts({ ...fields, title: "x".repeat(120) })).toBe(true);
    expect(accepts({ ...fields, title: "x".repeat(121) })).toBe(false);
    expect(accepts({ ...fields, title: "   " })).toBe(false);
    expect(accepts({ ...fields, title: "a\nb" })).toBe(false);
    expect(accepts({ ...fields, body: "a\u0000b" })).toBe(false);
    expect(accepts({ ...fields, body: "x".repeat(2_000) })).toBe(true);
    expect(accepts({ ...fields, body: "x".repeat(2_001) })).toBe(false);
    expect(accepts({ ...fields, body: "x".repeat(4_000) }, entry)).toBe(true);
    expect(accepts({ ...fields, body: "x".repeat(4_001) }, entry)).toBe(false);
    expect(accepts({ ...fields, extra: 1 })).toBe(false);
});

// Written as code points: the characters themselves would be invisible here.
const FORMAT = [0x202e, 0x2066, 0x200b, 0x00ad, 0xfeff, 0xe0041].map((c) =>
    String.fromCodePoint(c),
);

test("titles and bodies refuse format characters such as bidi overrides, in the contract and in the table", async () => {
    const add = webContract["admin.issues.add"].input;
    const fields = { productId: null, title: "one", body: "" };
    for (const sneaky of FORMAT) {
        expect(add.safeParse({ ...fields, title: `a${sneaky}b` }).success).toBe(false);
        expect(add.safeParse({ ...fields, body: `a${sneaky}b` }).success).toBe(false);
    }
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        for (const [table, at] of [
            [sql`known_issue`, sql`opened_at`],
            [sql`changelog_entry`, sql`published_at`],
        ] as const) {
            const refused = [
                ...FORMAT.flatMap((sneaky) => [
                    [`a${sneaky}b`, ""],
                    ["ab", `a${sneaky}b`],
                ]),
                [`a${String.fromCodePoint(7)}b`, ""],
            ];
            for (const [title, body] of refused) {
                const stored = await execute(
                    db,
                    sql`insert into ${table} (title, body, ${at}, updated_at)
                        values (${title}, ${body}, now(), now())`,
                );
                expect(stored.ok).toBe(false);
            }
            const plain = await execute(
                db,
                sql`insert into ${table} (title, body, ${at}, updated_at)
                    values ('ab', ${"line\nline\ttab"}, now(), now())`,
            );
            expect(plain).toEqual({ ok: true, value: 1 });
        }
    });
});
