import { ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import type { EpochMs } from "@lucent/core/scalars";
import { NONCE_SIZE, sealFrame, toFrameBytes } from "@lucent/wire/frame";
import { type ReportEvent, toReportsAckBytes } from "@lucent/wire/reports";
import { type DbFailure, execute, sql, type Tx, toTimestamptz } from "../db/pool.ts";

// What the reports route keeps of a batch: each event as module_report holds it, under the
// session's product and release and nothing that names the session, account or PC. The time is
// the hour it arrived: an exact one would match the module_trap signal written in the same
// transaction, which names the session and account.
export async function storeReports(
    tx: Tx,
    params: {
        readonly productId: string;
        readonly releaseId: Uint8Array;
        readonly events: readonly ReportEvent[];
        readonly at: EpochMs;
    },
): Promise<Result<void, DbFailure>> {
    const at = toTimestamptz(params.at);
    const hour = sql`date_trunc('hour', ${at}::timestamptz, 'UTC')`;
    for (const event of params.events) {
        const stored = await execute(
            tx,
            event.kind === "health"
                ? sql`insert into module_report
                          (product_id, release_id, received_at, session_ms, kind, event_id, subject,
                           value)
                      values (${params.productId}, ${params.releaseId}, ${hour},
                              ${event.time}, 'health', ${event.eventId}, ${event.subject},
                              ${event.value})`
                : sql`insert into module_report
                          (product_id, release_id, received_at, session_ms, kind, exception_code,
                           module_hash, rva, frames)
                      values (${params.productId}, ${params.releaseId}, ${hour},
                              ${event.time}, 'crash', ${event.exceptionCode}, ${event.moduleHash},
                              ${event.rva}, ${event.frames}::bigint[])`,
        );
        if (!stored.ok) return stored;
    }
    return ok(undefined);
}

// The ack, sealed as the server's frame at `sequence` on the reports route.
export function sealReportsAck(params: {
    readonly rng: CryptoRng;
    readonly key: Uint8Array;
    readonly session: Uint8Array;
    readonly sequence: bigint;
    readonly answers: bigint;
    readonly accepted: number;
}): Uint8Array<ArrayBuffer> {
    return toFrameBytes(
        sealFrame(params.key, {
            header: {
                session: params.session,
                direction: "server_to_module",
                sequence: params.sequence,
            },
            nonce: params.rng.fillBytes(new Uint8Array(NONCE_SIZE)),
            plain: toReportsAckBytes({ answers: params.answers, accepted: params.accepted }),
        }),
    );
}
