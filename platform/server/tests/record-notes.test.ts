import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { BearerToken, ProductId, toBase64Url } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { webContract } from "@lucent/rpc/web";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { webProcedures } from "../src/edge/listeners/internal/web-rpc.ts";
import type { ChangelogEntryFields } from "../src/members/record/notes.rules.ts";
import { addNote, deleteNote, listStaffNotes, updateNote } from "../src/members/record/notes.ts";
import {
    CHANGELOG_PAGE,
    listMemberChangelog,
    readMemberStatus,
} from "../src/members/record/status.ts";
import { memberSession, seedRootOnce } from "./auth-fixtures.ts";
import {
    catalog,
    product,
    scalar,
    seedAccount,
    seedRole,
    seedStaff,
    steppedUp,
} from "./authority-fixtures.ts";
import { NO_LOG } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import { liveCatalog } from "./record-fixtures.ts";

const CS2 = ProductId.parse("cs2");

const auditCount = (db: Db, operation: string) =>
    scalar(
        db,
        z.coerce.number(),
        sql`select count(*) as value from audit where operation = ${operation}`,
    );

function entryFields(over: Partial<ChangelogEntryFields>): ChangelogEntryFields {
    return {
        subject: "service",
        productId: null,
        version: null,
        title: "faster sign-in",
        added: [],
        changed: [],
        fixed: [],
        body: "it now takes a second less",
        releaseId: null,
        ...over,
    };
}

async function holdCs2(db: Db, accountId: string) {
    const entitlement = await execute(
        db,
        sql`insert into entitlement (id, account_id, valid_from)
            values (${`ent_${accountId.slice(-8)}`}, ${accountId}, now())`,
    );
    invariant(entitlement.ok, "the entitlement is written");
    const granted = await execute(
        db,
        sql`insert into entitlement_product (entitlement_id, product_id, features, channels)
            values (${`ent_${accountId.slice(-8)}`}, ${CS2}, '"*"'::jsonb, array['stable'])`,
    );
    invariant(granted.ok, "the product grant is written");
}

test("a changelog entry staff add appears in the member read and is gone once deleted", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_201);
        const products = liveCatalog();
        const auth = await createTestAuthDeps(db, rng);
        const caller = await steppedUp(db, await seedRootOnce(db, rng));
        const session = await memberSession(auth, caller.accountId);
        const entry = await addNote(db, { caller, catalog: products, fields: entryFields({}) });
        invariant(entry.ok, "the entry is added");

        const changelog = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: {},
        });
        invariant(changelog.ok, "the changelog reads");
        expect(changelog.value.entries).toMatchObject([
            {
                id: entry.value.id,
                subject: "service",
                productId: null,
                version: null,
                title: "faster sign-in",
                added: [],
            },
        ]);
        expect(changelog.value.next).toBeNull();
        const staff = await listStaffNotes(db, { caller });
        invariant(staff.ok, "staff list them");
        expect(staff.value.changelog.map((row) => row.id)).toEqual([entry.value.id]);

        expect((await deleteNote(db, { caller, id: entry.value.id })).ok).toBe(true);
        const emptied = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: {},
        });
        invariant(emptied.ok, "the changelog reads");
        expect(emptied.value.entries).toEqual([]);
        expect(await deleteNote(db, { caller, id: entry.value.id })).toEqual(
            err({ code: "NOT_FOUND" }),
        );

        for (const operation of ["changelog.add", "changelog.delete"]) {
            expect(await auditCount(db, operation)).toBe(1);
        }
    });
});

test("a title-and-body entry with empty lists and no version round-trips unchanged through read and update", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_204);
        const products = liveCatalog();
        const auth = await createTestAuthDeps(db, rng);
        const caller = await steppedUp(db, await seedRootOnce(db, rng));
        const session = await memberSession(auth, caller.accountId);
        const fields = entryFields({ title: "as entries always were", version: null });
        const added = await addNote(db, { caller, catalog: products, fields });
        invariant(added.ok, "the entry is added");

        const page = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: {},
        });
        invariant(page.ok, "the changelog reads");
        expect(page.value.entries).toMatchObject([
            {
                subject: "service",
                version: null,
                title: "as entries always were",
                added: [],
                changed: [],
                fixed: [],
                body: "it now takes a second less",
            },
        ]);

        expect(
            await updateNote(db, {
                caller,
                catalog: products,
                id: added.value.id,
                fields,
            }),
        ).toEqual({ ok: true, value: undefined });
        const reread = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: {},
        });
        invariant(reread.ok, "the changelog reads again");
        expect(reread.value.entries.map(({ updatedAt: _, ...row }) => row)).toEqual(
            page.value.entries.map(({ updatedAt: _, ...row }) => row),
        );
    });
});

test("a title-only row written before the entry shape, with an empty body and no lists, reads back unchanged", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_205);
        const products = liveCatalog();
        const auth = await createTestAuthDeps(db, rng);
        const root = await seedRootOnce(db, rng);
        const session = await memberSession(auth, root);

        // As migration 0039 found them: the row predates the content check, so the check is
        // dropped and re-added NOT VALID around the write, which never scans existing rows.
        invariant(
            (
                await execute(
                    db,
                    sql`alter table changelog_entry drop constraint changelog_entry_content_check`,
                )
            ).ok,
            "the check drops",
        );
        invariant(
            (
                await execute(
                    db,
                    sql`insert into changelog_entry
                            (subject, product_id, version, title, added, changed, fixed, body,
                             published_at, updated_at)
                        values ('service', null, null, 'as entries always were',
                                '{}', '{}', '{}', '', now(), now())`,
                )
            ).ok,
            "the legacy row writes",
        );
        invariant(
            (
                await execute(
                    db,
                    sql`alter table changelog_entry add constraint changelog_entry_content_check
                        check (body <> '' or cardinality(added) > 0 or cardinality(changed) > 0
                               or cardinality(fixed) > 0) not valid`,
                )
            ).ok,
            "the check returns",
        );

        const page = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: {},
        });
        invariant(page.ok, "the changelog reads");
        expect(page.value.entries).toMatchObject([
            {
                subject: "service",
                productId: null,
                version: null,
                title: "as entries always were",
                added: [],
                changed: [],
                fixed: [],
                body: "",
            },
        ]);
    });
});

test("an entry without a version or a title, or without any content, is refused and nothing is written", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const products = liveCatalog();
        const caller = await steppedUp(db, await seedRootOnce(db, createSeededRng(11_205)));
        const invalid = err({ code: "INVALID_ENTRY" });
        for (const fields of [
            entryFields({ title: null, version: null }),
            entryFields({ body: "" }),
            entryFields({ subject: "loader", productId: ProductId.parse("lucent-loader") }),
            entryFields({ subject: "product", productId: null }),
        ]) {
            expect(await addNote(db, { caller, catalog: products, fields })).toEqual(invalid);
        }
        // A version alone names it; a list alone is content.
        for (const fields of [
            entryFields({ title: null, version: "0.8.3-alpha.4", body: "", added: ["x"] }),
            entryFields({ body: "", fixed: ["a crash"] }),
        ]) {
            expect((await addNote(db, { caller, catalog: products, fields })).ok).toBe(true);
        }
    });
});

test("without releases:promote every write is refused and nothing is written", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_202);
        const products = liveCatalog();
        const root = await steppedUp(db, await seedRootOnce(db, rng));
        const entry = await addNote(db, {
            caller: root,
            catalog: products,
            fields: entryFields({ title: "one" }),
        });
        invariant(entry.ok, "root adds an entry");
        const roleId = await seedRole(db, {
            id: "role_facts",
            rank: 10,
            permissions: ["facts:promote"],
        });
        const caller = await steppedUp(
            db,
            await seedStaff(db, rng, { email: "facts@lucent.test", roleId }),
        );
        const forbidden = err({ code: "FORBIDDEN" });
        const fields = entryFields({ title: "two" });
        expect(await addNote(db, { caller, catalog: products, fields })).toEqual(forbidden);
        expect(
            await updateNote(db, { caller, catalog: products, id: entry.value.id, fields }),
        ).toEqual(forbidden);
        expect(await deleteNote(db, { caller, id: entry.value.id })).toEqual(forbidden);
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
        expect(staff.value.changelog).toMatchObject([{ title: "one" }]);
    });
});
test("entries of a seed product show only to a member who holds it, and an unknown product is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_203);
        const products = catalog();
        expect(products.get(CS2)?.state).toBe("seed");
        const auth = await createTestAuthDeps(db, rng);
        const caller = await steppedUp(db, await seedRootOnce(db, rng));
        const entry = await addNote(db, {
            caller,
            catalog: products,
            fields: entryFields({ subject: "product", productId: CS2, title: "unannounced" }),
        });
        invariant(entry.ok, "the entry is added");
        expect(
            await addNote(db, {
                caller,
                catalog: products,
                fields: entryFields({
                    subject: "product",
                    productId: ProductId.parse("nope"),
                    title: "x",
                }),
            }),
        ).toEqual(err({ code: "UNKNOWN_PRODUCT" }));

        // A stranger holds nothing: a seed product is not theirs to see, by id or in the stream.
        const stranger = await memberSession(
            auth,
            await seedAccount(db, rng, "stranger@lucent.test"),
        );
        const hidden = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: stranger,
            input: {},
        });
        invariant(hidden.ok, "the changelog reads");
        expect(hidden.value.entries).toEqual([]);
        expect(hidden.value.names).toEqual([]);
        const status = await readMemberStatus(db, { catalog: products, sessionToken: stranger });
        invariant(status.ok, "the status reads");
        expect(status.value.products).toEqual([]);
        // Asking for it by id is an empty page, not a refusal.
        const asked = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: stranger,
            input: { productId: CS2 },
        });
        invariant(asked.ok, "the filtered changelog reads");
        expect(asked.value.entries).toEqual([]);

        // A holder of the seed product sees it, its entries and its status.
        const holderId = await seedAccount(db, rng, "holder@lucent.test");
        await holdCs2(db, holderId);
        const holder = await memberSession(auth, holderId);
        const shown = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: holder,
            input: {},
        });
        invariant(shown.ok, "the changelog reads");
        expect(shown.value.entries.map((row) => row.id)).toEqual([entry.value.id]);
        expect(shown.value.names).toEqual([{ id: CS2, name: product("cs2").name }]);
        const own = await readMemberStatus(db, { catalog: products, sessionToken: holder });
        invariant(own.ok, "the status reads");
        expect(own.value.products.map((row) => row.productId)).toEqual([CS2]);
        const filtered = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: holder,
            input: { productId: CS2 },
        });
        invariant(filtered.ok, "the filtered changelog reads");
        expect(filtered.value.entries.map((row) => row.id)).toEqual([entry.value.id]);
        // The loader never appears as a product, however the member is scoped.
        expect(own.value.products.some((row) => String(row.productId) === "lucent-loader")).toBe(
            false,
        );
    });
});

test("the changelog pages 25 at a time through its cursor, newest first, and filters by subject and null product", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_206);
        const products = liveCatalog();
        const auth = await createTestAuthDeps(db, rng);
        const caller = await steppedUp(db, await seedRootOnce(db, rng));
        const session = await memberSession(auth, caller.accountId);
        // 27 service entries, a loader entry and a cs2 entry, all distinguishable.
        for (let i = 1; i <= 27; i += 1) {
            const added = await addNote(db, {
                caller,
                catalog: products,
                fields: entryFields({ title: `service ${String(i).padStart(2, "0")}` }),
            });
            invariant(added.ok, "the entry is added");
            // published_at ties order by id desc within one transaction time, so make times distinct.
            await execute(
                db,
                sql`update changelog_entry set published_at = now() + (${i} || ' seconds')::interval
                    where id = ${added.value.id}::uuid`,
            );
        }
        for (const [subject, productId, title, bump] of [
            ["loader", null, "loader one", 99],
            ["product", CS2, "cs2 one", 100],
        ] as const) {
            const added = await addNote(db, {
                caller,
                catalog: products,
                fields: entryFields({ subject, productId, title }),
            });
            invariant(added.ok, "the entry is added");
            await execute(
                db,
                sql`update changelog_entry set published_at = now() + (${bump} || ' seconds')::interval
                    where id = ${added.value.id}::uuid`,
            );
        }

        const first = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: {},
        });
        invariant(first.ok, "the first page reads");
        expect(first.value.entries.length).toBe(25);
        expect(first.value.next).not.toBeNull();
        // Newest first: the cs2 and loader entries carry the latest times.
        expect(first.value.entries[0]?.title).toBe("cs2 one");
        expect(first.value.entries[1]?.title).toBe("loader one");
        const second = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: { cursor: first.value.next ?? "never" },
        });
        invariant(second.ok, "the second page reads");
        expect(second.value.entries.length).toBe(4);
        expect(second.value.next).toBeNull();
        // No overlap, no gap: every entry exactly once, order kept.
        const titles = [...first.value.entries, ...second.value.entries].map((row) => row.title);
        expect(new Set(titles).size).toBe(29);

        // Null productId: the service's entries alone.
        const service = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: { productId: null },
        });
        invariant(service.ok, "the service page reads");
        expect(service.value.entries.length).toBe(25);
        expect(service.value.entries.every((row) => row.subject === "service")).toBe(true);

        // A subject narrows further: the loader's entries, then cs2's.
        const loader = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: { subject: "loader" },
        });
        invariant(loader.ok, "the loader page reads");
        expect(loader.value.entries.map((row) => row.title)).toEqual(["loader one"]);
        const own = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: { productId: CS2, subject: "product" },
        });
        invariant(own.ok, "the product page reads");
        expect(own.value.entries.map((row) => row.title)).toEqual(["cs2 one"]);
        // A subject that contradicts the product filter is empty, not an error.
        const mixed = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: { productId: CS2, subject: "loader" },
        });
        invariant(mixed.ok, "the mixed page reads");
        expect(mixed.value.entries).toEqual([]);

        const broken = await listMemberChangelog(db, {
            catalog: products,
            sessionToken: session,
            input: { cursor: "not-a-cursor" },
        });
        expect(broken).toEqual(err({ code: "INVALID_CURSOR" }));
    });
});

test("signed-out callers are refused on both record reads", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_207);
        const auth = await createTestAuthDeps(db, rng);
        const peerKey = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
        const app = mountInternalRpc({
            path: "/rpc",
            peerKey,
            procedures: webProcedures,
            createContext: () =>
                Promise.resolve(ok({ catalog: liveCatalog(), auth, logger: NO_LOG })),
            onUnhandledError: () => {},
        });
        const client = createRpcClient(webContract, {
            endpointUrl: "http://localhost/rpc",
            peerKey,
            fetcher: async (req) => await app.fetch(req),
        });
        // A signed-out caller's token never verifies; wrong-purpose sessions are covered for
        // every member procedure in web-contract.test.ts.
        const noOne = BearerToken.parse("a".repeat(43));
        expect(await client.call("record.status.get", {}, { session: noOne })).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
        expect(await client.call("record.changelog.list", {}, { session: noOne })).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
    });
});

test("entry fields are bounded plain text", () => {
    const add = webContract["admin.changelog.add"].input;
    const accepts = (input: unknown) => add.safeParse(input).success;
    const fields = {
        subject: "service",
        productId: null,
        version: "0.8.3",
        title: "one",
        added: [],
        changed: [],
        fixed: [],
        body: "line\nline\ttab",
    };
    expect(accepts(fields)).toBe(true);
    expect(accepts({ ...fields, title: "x".repeat(120) })).toBe(true);
    expect(accepts({ ...fields, title: "x".repeat(121) })).toBe(false);
    expect(accepts({ ...fields, title: "   " })).toBe(false);
    expect(accepts({ ...fields, title: "a\nb" })).toBe(false);
    expect(accepts({ ...fields, version: "v".repeat(40) })).toBe(true);
    expect(accepts({ ...fields, version: "v".repeat(41) })).toBe(false);
    expect(accepts({ ...fields, version: "a\nb" })).toBe(false);
    expect(accepts({ ...fields, added: ["x".repeat(200)] })).toBe(true);
    expect(accepts({ ...fields, added: ["x".repeat(201)] })).toBe(false);
    expect(accepts({ ...fields, added: [""] })).toBe(false);
    expect(accepts({ ...fields, added: Array(30).fill("one") })).toBe(true);
    expect(accepts({ ...fields, added: Array(31).fill("one") })).toBe(false);
    expect(accepts({ ...fields, body: "a b" })).toBe(false);
    expect(accepts({ ...fields, body: "x".repeat(4_000) })).toBe(true);
    expect(accepts({ ...fields, body: "x".repeat(4_001) })).toBe(false);
    expect(accepts({ ...fields, extra: 1 })).toBe(false);
});

// Written as code points: the characters themselves would be invisible here.
const FORMAT = [0x202e, 0x2066, 0x200b, 0x00ad, 0xfeff, 0xe0041].map((c) =>
    String.fromCodePoint(c),
);

test("titles and bodies refuse format characters such as bidi overrides, in the contract and in the table", async () => {
    const add = webContract["admin.changelog.add"].input;
    const fields = {
        subject: "service",
        productId: null,
        version: null,
        title: "one",
        added: [],
        changed: [],
        fixed: [],
        body: "",
    };
    for (const sneaky of FORMAT) {
        expect(add.safeParse({ ...fields, title: `a${sneaky}b` }).success).toBe(false);
        expect(add.safeParse({ ...fields, body: `a${sneaky}b` }).success).toBe(false);
    }
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
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
                sql`insert into changelog_entry (subject, title, body, published_at, updated_at)
                    values ('service', ${title}, ${body}, now(), now())`,
            );
            expect(stored.ok).toBe(false);
        }
        const plain = await execute(
            db,
            sql`insert into changelog_entry (subject, title, body, published_at, updated_at)
                values ('service', 'ab', ${"line\nline\ttab"}, now(), now())`,
        );
        expect(plain).toEqual({ ok: true, value: 1 });
    });
});
test("the table mirrors the entry rules: a product exactly for a product subject, a name, and some content", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const insert = (over: {
            subject?: string;
            productId?: string | null;
            version?: string | null;
            title?: string | null;
            body?: string;
            added?: readonly string[];
        }) =>
            execute(
                db,
                sql`insert into changelog_entry
                        (subject, product_id, version, title, added, body, published_at, updated_at)
                    values (${over.subject ?? "service"}, ${over.productId ?? null},
                            ${over.version === undefined ? null : over.version},
                            ${over.title === undefined ? "one" : over.title},
                            ${over.added ?? []}, ${over.body ?? "text"}, now(), now())`,
            );
        expect((await insert({})).ok).toBe(true);
        // A product subject needs its product; other subjects need none.
        expect((await insert({ subject: "product", productId: null })).ok).toBe(false);
        expect((await insert({ subject: "service", productId: CS2 })).ok).toBe(false);
        expect((await insert({ subject: "product", productId: CS2 })).ok).toBe(true);
        // A version or a title, and some content.
        expect((await insert({ title: null, version: null })).ok).toBe(false);
        expect((await insert({ title: null, version: "0.8.3" })).ok).toBe(true);
        expect((await insert({ body: "", added: [] })).ok).toBe(false);
        expect((await insert({ body: "", added: ["a line"] })).ok).toBe(true);
        // Lines are bounded plain text, 30 at most.
        expect((await insert({ added: ["x".repeat(201)] })).ok).toBe(false);
        expect((await insert({ added: Array(31).fill("one") })).ok).toBe(false);
        expect((await insert({ added: [`a${FORMAT[0]}b`] })).ok).toBe(false);
        expect((await insert({ version: "v".repeat(41) })).ok).toBe(false);
    });
});

test("the changelog pages through entries published in the same instant without skipping any", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_230);
        const products = liveCatalog();
        const auth = await createTestAuthDeps(db, rng);
        const session = await memberSession(auth, await seedRootOnce(db, rng));
        // One statement, one timestamp with microseconds a millisecond cursor would cut.
        const total = CHANGELOG_PAGE + 3;
        expect(
            await execute(
                db,
                sql`insert into changelog_entry (title, body, subject, published_at, updated_at)
                    select 'entry ' || n, 'body', 'service',
                           timestamptz '2026-01-01 00:00:00.123456+00', now()
                    from generate_series(1, ${total}) n`,
            ),
        ).toEqual({ ok: true, value: total });

        const seen: string[] = [];
        let cursor: string | undefined;
        for (let pages = 0; pages < 5; pages++) {
            const page = await listMemberChangelog(db, {
                catalog: products,
                sessionToken: session,
                input: cursor === undefined ? {} : { cursor },
            });
            invariant(page.ok, "the changelog reads");
            seen.push(...page.value.entries.map((entry) => entry.id));
            if (page.value.next === null) break;
            cursor = page.value.next;
        }
        expect(seen.length).toBe(total);
        expect(new Set(seen).size).toBe(total);
        const order = await queryAll(
            db,
            z.object({ id: z.string() }),
            sql`select id::text as id from changelog_entry order by published_at desc, id desc`,
        );
        invariant(order.ok, "the order reads");
        expect(seen).toEqual(order.value.map((row) => row.id));
    });
});

test("a changelog cursor that is not one of ours, or whose id is not a uuid, is invalid rather than a database error", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(11_231);
        const products = liveCatalog();
        const auth = await createTestAuthDeps(db, rng);
        const session = await memberSession(auth, await seedRootOnce(db, rng));
        const encode = (value: unknown) =>
            toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
        for (const cursor of [
            "nope!",
            encode([1_767_225_600_123, "not-a-uuid"]),
            encode(["1767225600123456", "not-a-uuid"]),
            encode(["1767225600123456", "00000000-0000-4000-8000-000000000001", "x"]),
        ]) {
            expect(
                await listMemberChangelog(db, {
                    catalog: products,
                    sessionToken: session,
                    input: { cursor },
                }),
            ).toEqual(err({ code: "INVALID_CURSOR" }));
        }
    });
});
