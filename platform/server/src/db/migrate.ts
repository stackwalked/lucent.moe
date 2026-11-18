import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { invariant, raiseInvariant } from "../core/contain.ts";
import { err, ok, type Result } from "../core/result.ts";
import { sha256Hex } from "../core/scalars.ts";
import {
    type CheckedOutClient,
    checkoutClient,
    type Db,
    type DbFailure,
    execute,
    executeScript,
    type Queryable,
    queryAll,
    queryOne,
    readSqlScript,
    type SqlScript,
    sql,
} from "./pool.ts";

// Fixed advisory lock key ("lucent.migrations").
const MIGRATION_LOCK_KEY = 0x5e41_5e01;

const DEFAULT_MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

export type MigrationFile = {
    readonly version: number;
    readonly name: string;
    readonly script: SqlScript;
    readonly checksum: string;
};

export type MigrationError =
    | DbFailure
    | { readonly code: "CHECKSUM_MISMATCH"; readonly label: string }
    | { readonly code: "SCHEMA_AHEAD"; readonly versions: readonly number[] }
    | { readonly code: "SCHEMA_MISMATCH"; readonly current: number; readonly expected: number };

const LEDGER_DDL = sql`
create table if not exists schema_migration (
    version     integer primary key,
    name        text not null,
    checksum    text not null,
    applied_at  timestamptz not null default now()
)`;

const AppliedRowSchema = z.object({
    version: z.number().int().positive(),
    checksum: z.string(),
});
type AppliedRow = z.output<typeof AppliedRowSchema>;

export async function loadMigrations(
    dir = DEFAULT_MIGRATIONS_DIR,
): Promise<readonly MigrationFile[]> {
    const entries = readdirSync(dir)
        .filter((file) => file.endsWith(".sql"))
        .sort();

    const loaded: MigrationFile[] = [];
    for (let i = 0; i < entries.length; i++) {
        const file = entries[i];
        invariant(file !== undefined, "expected migration filename");
        const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
        invariant(match !== null, `migration ${file} must match NNNN_name.sql`);
        const version = Number(match[1]);
        const name = match[2] ?? "";
        invariant(
            version === i + 1,
            `migration ${file} is out of sequence; expected version ${i + 1}`,
        );
        const script = readSqlScript(join(dir, file));
        const checksum = await sha256Hex(script.text);
        loaded.push({ version, name, script, checksum });
    }
    return loaded;
}

function migrationLabel(m: MigrationFile): string {
    return `${String(m.version).padStart(4, "0")}_${m.name}`;
}

// The ledger agrees with the code when every applied row matches its file's checksum and none is
// newer than the code knows. Rows missing at the end are pending, not a disagreement.
function compareLedger(
    applied: readonly AppliedRow[],
    list: readonly MigrationFile[],
): Result<void, MigrationError> {
    const recorded = new Map(applied.map((row) => [row.version, row.checksum]));
    for (const m of list) {
        const checksum = recorded.get(m.version);
        if (checksum !== undefined && checksum !== m.checksum) {
            return err({ code: "CHECKSUM_MISMATCH", label: migrationLabel(m) });
        }
    }
    const ahead = applied.map((row) => row.version).filter((v) => v > list.length);
    if (ahead.length > 0) {
        return err({ code: "SCHEMA_AHEAD", versions: ahead });
    }
    return ok(undefined);
}

async function readLedger(q: Queryable): Promise<Result<readonly AppliedRow[], DbFailure>> {
    return await queryAll(
        q,
        AppliedRowSchema,
        sql`select version, checksum from schema_migration order by version`,
    );
}

export async function migrateDatabase(
    db: Db,
    migrations?: readonly MigrationFile[],
): Promise<Result<readonly number[], MigrationError>> {
    const list = migrations ?? (await loadMigrations());
    const checkedOut = await checkoutClient(db);
    if (!checkedOut.ok) return checkedOut;
    const client = checkedOut.value;
    const { tx } = client;

    const lockRes = await execute(tx, sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    if (!lockRes.ok) {
        client.destroy();
        return lockRes;
    }
    const outcome = await applyPending(client, list);
    const unlockRes = await execute(tx, sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    if (unlockRes.ok) {
        client.release();
    } else {
        // A session-level lock dies with its connection.
        client.destroy();
    }
    return outcome;
}

async function applyPending(
    client: CheckedOutClient,
    list: readonly MigrationFile[],
): Promise<Result<readonly number[], MigrationError>> {
    const { tx } = client;
    const ledgerRes = await execute(tx, LEDGER_DDL);
    if (!ledgerRes.ok) return ledgerRes;

    const appliedRes = await readLedger(tx);
    if (!appliedRes.ok) return appliedRes;
    const agreed = compareLedger(appliedRes.value, list);
    if (!agreed.ok) return agreed;

    const appliedVersions = new Set(appliedRes.value.map((row) => row.version));
    const newlyApplied: number[] = [];
    for (const m of list) {
        if (appliedVersions.has(m.version)) continue;

        const beginRes = await client.begin();
        if (!beginRes.ok) return beginRes;

        const applyRes = await executeScript(tx, m.script);
        if (!applyRes.ok) {
            await client.rollback();
            return applyRes;
        }
        const insertRes = await execute(
            tx,
            sql`insert into schema_migration (version, name, checksum)
                values (${m.version}, ${m.name}, ${m.checksum})`,
        );
        if (!insertRes.ok) {
            await client.rollback();
            return insertRes;
        }
        const commitRes = await client.commit();
        if (!commitRes.ok) return commitRes;
        if (commitRes.value === "rolled back") {
            raiseInvariant(`migration ${migrationLabel(m)} rolled back without a failed statement`);
        }
        newlyApplied.push(m.version);
    }
    return ok(newlyApplied);
}

const LedgerPresentSchema = z.object({ present: z.boolean() });

export async function verifySchemaCurrent(
    db: Db,
    migrations?: readonly MigrationFile[],
): Promise<Result<number, MigrationError>> {
    const list = migrations ?? (await loadMigrations());
    const expected = list.length;

    const presentRes = await queryOne(
        db,
        LedgerPresentSchema,
        sql`select to_regclass('schema_migration') is not null as present`,
    );
    if (!presentRes.ok) return presentRes;
    if (presentRes.value?.present !== true) {
        return err({ code: "SCHEMA_MISMATCH", current: 0, expected });
    }

    const appliedRes = await readLedger(db);
    if (!appliedRes.ok) return appliedRes;
    const agreed = compareLedger(appliedRes.value, list);
    if (!agreed.ok) return agreed;

    const current = appliedRes.value.length;
    if (current !== expected) {
        return err({ code: "SCHEMA_MISMATCH", current, expected });
    }
    return ok(current);
}
