import { ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

export const USAGE_WEEKS = 12;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type UsageWindow = { readonly from: EpochMs; readonly until: EpochMs };

// The USAGE_WEEKS whole ISO weeks (Monday 00:00 UTC to Monday) ending with the one holding
// `endingWith`. Day 0, 1970-01-01, was a Thursday, so a day's Monday is `(day + 3) % 7` days back.
export function decideUsageWindow(endingWith: EpochMs): Result<UsageWindow, never> {
    const day = Math.floor(endingWith / DAY_MS);
    const monday = day - ((day + 3) % 7);
    const until = (monday + 7) * DAY_MS;
    return ok({
        from: EpochMs.parse(Math.max(0, until - USAGE_WEEKS * WEEK_MS)),
        until: EpochMs.parse(until),
    });
}
