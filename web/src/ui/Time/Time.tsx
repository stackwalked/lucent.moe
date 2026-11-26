import { toIsoTimestamp } from "@lucent/core/clock";
import type { EpochMs } from "@lucent/core/scalars";
import { formatAbsolute, formatDate, formatDay, formatMonth, formatRelative } from "./format.ts";
import { useTimeContext } from "./TimeProvider.tsx";

// A moment as text, always inside <time> so the machine-readable value travels with it. Relative
// text keeps the absolute time in its title. "month" ("mar 2025") and "day" ("24 nov") are for
// lists, where the rest of the moment would only add noise; their title keeps the whole of it.
export function Time({
    at,
    format = "absolute",
}: {
    readonly at: EpochMs;
    readonly format?: "absolute" | "relative" | "date" | "month" | "day";
}) {
    const { timeZone, now } = useTimeContext();
    const absolute = formatAbsolute(at, timeZone);
    if (format === "date")
        return <time dateTime={toIsoTimestamp(at)}>{formatDate(at, timeZone)}</time>;
    if (format === "month")
        return (
            <time dateTime={toIsoTimestamp(at)} title={absolute}>
                {formatMonth(at, timeZone)}
            </time>
        );
    if (format === "day")
        return (
            <time dateTime={toIsoTimestamp(at)} title={absolute}>
                {formatDay(at, timeZone)}
            </time>
        );
    if (format === "absolute") return <time dateTime={toIsoTimestamp(at)}>{absolute}</time>;
    return (
        <time dateTime={toIsoTimestamp(at)} title={absolute}>
            {formatRelative(at, now)}
        </time>
    );
}
