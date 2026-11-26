import { ok, type Result } from "@lucent/core/result";
import type { ClientInfo, EpochMs } from "@lucent/core/scalars";
import type { AuditOperation } from "@lucent/policy/operations";
import { type DbFailure, execute, sql, type Tx, toTimestamptz } from "./pool.ts";

// Append-only and never locked, so it's written last in a transaction (platform/AGENTS.md).
// `client` is null when the actor wasn't a browser (ops) or web didn't say.
export async function appendAudit(
    tx: Tx,
    params: {
        readonly actorId: string;
        readonly operation: AuditOperation;
        readonly target: Record<string, unknown>;
        readonly at: EpochMs;
        readonly client: ClientInfo | null;
    },
): Promise<Result<void, DbFailure>> {
    const res = await execute(
        tx,
        sql`insert into audit (at, actor_id, operation, target, client_ip, user_agent)
            values (${toTimestamptz(params.at)}::timestamptz, ${params.actorId}, ${params.operation},
                    ${JSON.stringify(params.target)}::jsonb, ${params.client?.ip ?? null}::inet,
                    ${params.client?.userAgent ?? null})`,
    );
    if (!res.ok) return res;
    return ok(undefined);
}
