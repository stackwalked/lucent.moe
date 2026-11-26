import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { ACCOUNT_REFERENCES } from "../src/identity/deletion/references.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

// Every column that can hold an account id, from the catalog: each column of a declared foreign
// key to `account`, each text column named like an account id or an actor (`*account_id`,
// `*author_id`, `*owner_id`, `*recipient_id`, `*_by`, `actor_id`, `principal`) that declares none,
// and every json column, since ids sit inside those under any key. What it can't see: an id in a
// text column named otherwise, in an array, or composed into another string (a receipt principal
// `<account>/<product>`, a setup token's `invite:<id>` issuer), and an address or username copied
// into free text.
async function accountColumns(db: Db): Promise<readonly string[]> {
    const rows = await queryAll(
        db,
        z.object({ name: z.string() }),
        sql`select c.conrelid::regclass::text || '.' || a.attname as name
            from pg_constraint c
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
            where c.contype = 'f' and c.confrelid = 'account'::regclass
            union
            select col.table_name || '.' || col.column_name
            from information_schema.columns col
            where col.table_schema = 'public' and col.data_type = 'text'
              and col.table_name <> 'account'
              and col.column_name ~ '(account_id|author_id|owner_id|recipient_id|_by|^actor_id|^principal)$'
            union
            select col.table_name || '.' || col.column_name
            from information_schema.columns col
            where col.table_schema = 'public' and col.data_type in ('jsonb', 'json')
            order by 1`,
    );
    invariant(rows.ok, `reading the catalog failed: ${JSON.stringify(rows)}`);
    return rows.value.map((row) => row.name);
}

function unclassified(columns: readonly string[]) {
    const classified = new Set(Object.keys(ACCOUNT_REFERENCES));
    const found = new Set(columns);
    return {
        missing: columns.filter((column) => !classified.has(column)),
        stale: [...classified].filter((column) => !found.has(column)).sort(),
    };
}

test("every column holding an account id is classified as goes or stays, and nothing else is", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const columns = await accountColumns(db);
        // The walk finds what it should: foreign keys, a composite one's column, and a bare id.
        expect(columns).toContain("passkey.account_id");
        expect(columns).toContain("cloud_version.account_id");
        expect(columns).toContain("audit.actor_id");
        expect(unclassified(columns)).toEqual({ missing: [], stale: [] });
    });
});

test("a new reference to account that nobody classified fails the walk", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const created = await execute(
            db,
            sql`create table deletion_probe (
                    owner text references account (id),
                    approved_by text,
                    owner_id text,
                    detail jsonb,
                    note text)`,
        );
        expect(created.ok).toBe(true);
        expect(unclassified(await accountColumns(db))).toEqual({
            missing: [
                "deletion_probe.approved_by",
                "deletion_probe.detail",
                "deletion_probe.owner",
                "deletion_probe.owner_id",
            ],
            stale: [],
        });
    });
});

test("each classification says why", () => {
    for (const [column, fate] of Object.entries(ACCOUNT_REFERENCES)) {
        expect({ column, why: fate.why.length > 0 }).toEqual({ column, why: true });
    }
});
