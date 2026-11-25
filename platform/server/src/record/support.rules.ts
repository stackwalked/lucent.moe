import { type Ok, ok, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";
import { decideUpdateDayLatency, type UpdateDayLatency } from "../facts/updates.rules.ts";

// What a writer that may have moved a product's support state records. `recorded` is the stored
// state (null: none yet), `now` what the shared rule says now (null: the product has no status,
// so there is nothing to compare). A product never recorded counts as supported: its first state
// is a change only when it is a drop. `change` says a state-change row is written.
export type SupportWrite = { readonly supported: boolean; readonly change: boolean };

export function decideSupportWrite(params: {
    readonly recorded: boolean | null;
    readonly now: boolean | null;
}): Ok<SupportWrite | null> {
    const { recorded, now } = params;
    if (now === null || recorded === now) return ok(null);
    if (recorded === null) return ok({ supported: now, change: !now });
    return ok({ supported: now, change: true });
}

export type SupportChange = {
    readonly supported: boolean;
    readonly changedAt: EpochMs;
};

// One game update as the public sees it: from the drop to the rise that cleared it, or open since
// the drop. The duration is update-day latency (facts/updates.rules.ts): the drop is recorded by
// the start that first reported the uncovered build, the rise by the promotion that covered it.
export type Recovery = {
    readonly startedAt: EpochMs;
    readonly endedAt: EpochMs | null;
    readonly latency: UpdateDayLatency;
};

// `changes` oldest first; the recoveries come newest first. A rise with no drop before it (cut off
// by the read's bound) is skipped; so is a second drop with no rise between, which a writer never
// records.
export function decideRecoveries(params: {
    readonly changes: readonly SupportChange[];
    readonly txNow: EpochMs;
}): Result<readonly Recovery[], never> {
    const spans: { readonly startedAt: EpochMs; readonly endedAt: EpochMs | null }[] = [];
    let open: EpochMs | null = null;
    for (const change of params.changes) {
        if (!change.supported) {
            open ??= change.changedAt;
            continue;
        }
        if (open === null) continue;
        spans.push({ startedAt: open, endedAt: change.changedAt });
        open = null;
    }
    if (open !== null) spans.push({ startedAt: open, endedAt: null });
    const recoveries: Recovery[] = [];
    for (const span of spans.reverse()) {
        const latency = decideUpdateDayLatency({
            firstReportedAt: span.startedAt,
            firstCoveredAt: span.endedAt,
            txNow: params.txNow,
        });
        if (!latency.ok) return latency;
        recoveries.push({ ...span, latency: latency.value });
    }
    return ok(recoveries);
}
