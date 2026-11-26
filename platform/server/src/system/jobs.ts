import { ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    sql,
    toTimestamptz,
} from "../base/db/pool.ts";
import type { JobRun, RecordJobRun } from "../base/jobs/runner.ts";

// The runner's memory of each job (migrations/0023_job_run.sql), kept across restarts and shared by
// every instance: staff read whichever instance ran it last. A run older than the one recorded
// never overwrites it, so an instance handing over can't put an older run back on top.
export function recordJobRuns(db: Db): RecordJobRun {
    return async (run: JobRun) => {
        const at = toTimestamptz(run.ranAt);
        const failedAt = run.failure === null ? null : at;
        const written = await execute(
            db,
            sql`insert into job_run as j (name, ran_at, duration_ms, failed, failed_at, failure)
                values (${run.name}, ${at}::timestamptz, ${run.durationMs}, ${run.failure !== null},
                        ${failedAt}::timestamptz, ${run.failure})
                on conflict (name) do update set
                    ran_at = excluded.ran_at,
                    duration_ms = excluded.duration_ms,
                    failed = excluded.failed,
                    failed_at = coalesce(excluded.failed_at, j.failed_at),
                    failure = coalesce(excluded.failure, j.failure)
                where j.ran_at <= excluded.ran_at`,
        );
        return written.ok ? ok(undefined) : written;
    };
}

export type JobState = {
    readonly name: string;
    readonly ranAt: EpochMs;
    readonly durationMs: number;
    readonly failed: boolean;
    readonly lastFailure: { readonly at: EpochMs; readonly reason: string } | null;
};

const JobRow = z.object({
    name: z.string(),
    ran_at: EpochMs,
    duration_ms: z.number().int().nonnegative(),
    failed: z.boolean(),
    failed_at: EpochMs.nullable(),
    failure: z.string().nullable(),
});

export async function readJobStates(q: Queryable): Promise<Result<readonly JobState[], DbFailure>> {
    const rows = await queryAll(
        q,
        JobRow,
        sql`select name, ran_at, duration_ms, failed, failed_at, failure from job_run order by name`,
    );
    if (!rows.ok) return rows;
    return ok(
        rows.value.map((row) => ({
            name: row.name,
            ranAt: row.ran_at,
            durationMs: row.duration_ms,
            failed: row.failed,
            lastFailure:
                row.failed_at === null || row.failure === null
                    ? null
                    : { at: row.failed_at, reason: row.failure },
        })),
    );
}
