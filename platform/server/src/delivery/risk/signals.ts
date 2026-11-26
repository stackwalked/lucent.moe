import { ok, type Result } from "@lucent/core/result";
import type { AccountId, EpochMs } from "@lucent/core/scalars";
import { type DbFailure, execute, sql, type Tx, toTimestamptz } from "../../base/db/pool.ts";
import type { SignalKind } from "./signals.rules.ts";

// Append-only and never locked, like audit: written last in the transaction that observed them.
export async function appendSignals(
    tx: Tx,
    params: {
        readonly accountId: AccountId;
        readonly releaseId: Uint8Array | null;
        readonly sessionId: Uint8Array | null;
        readonly kinds: readonly SignalKind[];
        readonly at: EpochMs;
    },
): Promise<Result<void, DbFailure>> {
    for (const kind of params.kinds) {
        const appended = await execute(
            tx,
            sql`insert into risk_signal (account_id, release_id, session_id, kind, observed_at)
                values (${params.accountId}, ${params.releaseId}, ${params.sessionId}, ${kind},
                        ${toTimestamptz(params.at)}::timestamptz)`,
        );
        if (!appended.ok) return appended;
    }
    return ok(undefined);
}
