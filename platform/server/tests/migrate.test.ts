import { expect, test } from "bun:test";
import { invariant } from "../src/core/contain.ts";
import { err, ok } from "../src/core/result.ts";
import {
    loadMigrations,
    type MigrationFile,
    migrateDatabase,
    verifySchemaCurrent,
} from "../src/db/migrate.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const ZERO_CHECKSUM = "0".repeat(64);

function withEditedFirst(migrations: readonly MigrationFile[]): readonly MigrationFile[] {
    const [first, ...rest] = migrations;
    invariant(first !== undefined, "expected at least one migration");
    return [{ ...first, checksum: ZERO_CHECKSUM }, ...rest];
}

test("migrating twice applies each migration once", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(
        async ({ nativeDb }) => {
            const migrations = await loadMigrations();
            const versions = migrations.map((m) => m.version);
            expect(await migrateDatabase(nativeDb, migrations)).toEqual(ok(versions));
            expect(await migrateDatabase(nativeDb, migrations)).toEqual(ok([]));
        },
        { template: "empty" },
    );
});

test("migrating refuses a database whose applied migration was since edited", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const edited = withEditedFirst(await loadMigrations());
        expect(await migrateDatabase(nativeDb, edited)).toEqual(
            err({ code: "CHECKSUM_MISMATCH", label: "0001_authority" }),
        );
    });
});

test("migrating refuses a database ahead of the code", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        expect(await migrateDatabase(nativeDb, [])).toEqual(
            err({ code: "SCHEMA_AHEAD", versions: [1] }),
        );
    });
});

test("a migrated database verifies as current", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const migrations = await loadMigrations();
        expect(await verifySchemaCurrent(nativeDb, migrations)).toEqual(ok(migrations.length));
    });
});

test("verification refuses an unmigrated database", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(
        async ({ nativeDb }) => {
            const migrations = await loadMigrations();
            expect(await verifySchemaCurrent(nativeDb, migrations)).toEqual(
                err({ code: "SCHEMA_MISMATCH", current: 0, expected: migrations.length }),
            );
        },
        { template: "empty" },
    );
});

test("verification refuses a database whose applied migration was since edited", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const edited = withEditedFirst(await loadMigrations());
        expect(await verifySchemaCurrent(nativeDb, edited)).toEqual(
            err({ code: "CHECKSUM_MISMATCH", label: "0001_authority" }),
        );
    });
});

test("verification reports an unreachable database as a database failure", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const migrations = await loadMigrations();
        await nativeDb.close();
        const verified = await verifySchemaCurrent(nativeDb, migrations);
        expect(verified.ok ? null : verified.error.code).toBe("DB_UNAVAILABLE");
    });
});
