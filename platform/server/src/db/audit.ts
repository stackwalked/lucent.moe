import { ok, type Result } from "../core/result.ts";
import type { EpochMs } from "../core/scalars.ts";
import { type DbFailure, execute, sql, type Tx, toTimestamptz } from "./pool.ts";

// Append-only and never locked, so it's written last in a transaction (platform/AGENTS.md).
export async function appendAudit(
    tx: Tx,
    params: {
        readonly actorId: string;
        readonly operation: string;
        readonly target: Record<string, unknown>;
        readonly at: EpochMs;
    },
): Promise<Result<void, DbFailure>> {
    const res = await execute(
        tx,
        sql`insert into audit (at, actor_id, operation, target)
            values (${toTimestamptz(params.at)}::timestamptz, ${params.actorId}, ${params.operation}, ${JSON.stringify(params.target)}::jsonb)`,
    );
    if (!res.ok) return res;
    return ok(undefined);
}
