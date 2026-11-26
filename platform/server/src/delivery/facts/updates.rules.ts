import { ok, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";

// Update-day latency of one module build: from the first start that reported it to the first
// promotion that made a set listing it current. A build covered before anyone reported it had no
// wait. One still uncovered is waiting, for as long as it has been since the report.
export type UpdateDayLatency =
    | { readonly state: "covered"; readonly latencyMs: number }
    | { readonly state: "waiting"; readonly waitingMs: number };

export function decideUpdateDayLatency(params: {
    readonly firstReportedAt: EpochMs;
    readonly firstCoveredAt: EpochMs | null;
    readonly txNow: EpochMs;
}): Result<UpdateDayLatency, never> {
    const { firstReportedAt, firstCoveredAt } = params;
    if (firstCoveredAt === null) {
        return ok({ state: "waiting", waitingMs: Math.max(0, params.txNow - firstReportedAt) });
    }
    return ok({ state: "covered", latencyMs: Math.max(0, firstCoveredAt - firstReportedAt) });
}
