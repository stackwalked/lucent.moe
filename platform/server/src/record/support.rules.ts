import { type Ok, ok, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";
import { decideUpdateDayLatency, type UpdateDayLatency } from "../facts/updates.rules.ts";

// How an event moves a product's recorded support state. `down`: a drop is open. `covered`: for
// a first report, whether the first channel's release covers the start's builds; for a
// promotion with a drop open, whether it now covers the drop's builds; for a release promotion
// with none open, whether it covers the game's builds. A start never records a rise, and a fact
// set promotion never a drop: only what is newly reported or newly promoted moves the state.
export type SupportEvent = "first_report" | "fact_promotion" | "release_promotion";

export function decideSupportMove(params: {
    readonly down: boolean;
    readonly event: SupportEvent;
    readonly covered: boolean;
}): Ok<"drop" | "rise" | null> {
    const { down, event, covered } = params;
    if (down) return ok(event !== "first_report" && covered ? "rise" : null);
    if (covered || event === "fact_promotion") return ok(null);
    return ok("drop");
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
