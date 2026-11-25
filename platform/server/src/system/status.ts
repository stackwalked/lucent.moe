import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, ServiceEpoch } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Forbidden, readAsStaff } from "../authority/staff.ts";
import { loadMigrations } from "../db/migrate.ts";
import { type Db, type DbFailure, type Queryable, queryAll, queryOne, sql } from "../db/pool.ts";
import { type JobState, readJobStates } from "./jobs.ts";

// What the server already knows about its own health, for staff: nothing here is collected for
// the page. Connections are PostgreSQL's view of every pool on this database, the server's
// (`platform-server/internal`, `/native`) and ops' alike, so an instance handing over shows too.

export type Connections = {
    readonly application: string;
    readonly total: number;
    readonly active: number;
    readonly idleInTransaction: number;
};

export type MailBacklog = {
    readonly pending: number;
    readonly sending: number;
    // The earliest a waiting mail was due; in the past when delivery is behind.
    readonly oldestDueAt: EpochMs | null;
};

export type ArtifactUse =
    | { readonly state: "none" }
    | { readonly state: "unreadable" }
    | { readonly state: "read"; readonly files: number; readonly bytes: number };

export type SystemStatus = {
    readonly epoch: ServiceEpoch;
    // The migrations the database has applied and the ones this build carries; they differ
    // between `ops migrate` and the deploy that follows it.
    readonly schema: { readonly database: number; readonly build: number };
    readonly jobs: readonly JobState[];
    readonly connections: readonly Connections[];
    readonly mail: MailBacklog;
    readonly artifacts: ArtifactUse;
};

const Count = z.coerce.number().int().nonnegative();

async function readDatabaseSide(q: Queryable) {
    const epoch = await queryOne(
        q,
        z.object({ epoch: z.coerce.number().pipe(ServiceEpoch), schema: Count }),
        sql`select (select epoch from service where id = true) as epoch,
                   (select coalesce(max(version), 0) from schema_migration) as schema`,
    );
    if (!epoch.ok) return epoch;
    const jobs = await readJobStates(q);
    if (!jobs.ok) return jobs;
    const connections = await queryAll(
        q,
        z.object({
            application: z.string(),
            total: Count,
            active: Count,
            idle_in_transaction: Count,
        }),
        sql`select left(coalesce(application_name, ''), 64) as application, count(*) as total,
                   count(*) filter (where state = 'active') as active,
                   count(*) filter (where state like 'idle in transaction%') as idle_in_transaction
            from pg_stat_activity
            where datname = current_database() and backend_type = 'client backend'
            group by 1 order by 1`,
    );
    if (!connections.ok) return connections;
    const mail = await queryOne(
        q,
        z.object({ pending: Count, sending: Count, oldest_due_at: EpochMs.nullable() }),
        sql`select count(*) filter (where state = 'pending') as pending,
                   count(*) filter (where state = 'sending') as sending,
                   min(due_at) filter (where state = 'pending') as oldest_due_at
            from mail_outbox where state in ('pending', 'sending')`,
    );
    if (!mail.ok) return mail;
    return ok({
        epoch: epoch.value?.epoch ?? null,
        schema: epoch.value?.schema ?? 0,
        jobs: jobs.value,
        connections: connections.value.map((row) => ({
            application: row.application,
            total: row.total,
            active: row.active,
            idleInTransaction: row.idle_in_transaction,
        })),
        mail: {
            pending: mail.value?.pending ?? 0,
            sending: mail.value?.sending ?? 0,
            oldestDueAt: mail.value?.oldest_due_at ?? null,
        },
    });
}

// Every file under the directory, partial publishes included. Read after the transaction: no
// filesystem I/O while a Tx is held.
async function measureArtifacts(dir: string | null): Promise<ArtifactUse> {
    if (dir === null) return { state: "none" };
    const measured = await tryAsync(
        async () => {
            const entries = await readdir(dir, { withFileTypes: true, recursive: true });
            let files = 0;
            let bytes = 0;
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                files += 1;
                bytes += (await stat(join(entry.parentPath, entry.name))).size;
            }
            return { files, bytes };
        },
        () => null,
    );
    if (!measured.ok) return { state: "unreadable" };
    return { state: "read", ...measured.value };
}

export async function readSystemStatus(
    db: Db,
    params: { readonly caller: Caller; readonly artifactDir: string | null },
): Promise<Result<SystemStatus, Forbidden | DbFailure>> {
    const build = (await loadMigrations()).length;
    const side = await readAsStaff(db, { caller: params.caller, actions: ["audit:read"] }, (q) =>
        readDatabaseSide(q),
    );
    if (!side.ok) return side;
    const { epoch, schema, ...rest } = side.value;
    if (epoch === null) {
        return err({ code: "DB_UNAVAILABLE", detail: "service singleton row is missing" });
    }
    return ok({
        epoch,
        schema: { database: schema, build },
        ...rest,
        artifacts: await measureArtifacts(params.artifactDir),
    });
}
