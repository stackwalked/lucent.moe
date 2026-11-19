import { toIsoTimestamp } from "@lucent/core/clock";
import type { EpochMs } from "@lucent/core/scalars";
import { formatAbsolute, formatRelative } from "./format.ts";
import { useTimeContext } from "./TimeProvider.tsx";

// A moment as text, always inside <time> so the machine-readable value travels with it. Relative
// text keeps the absolute time in its title.
export function Time({
    at,
    format = "absolute",
}: {
    readonly at: EpochMs;
    readonly format?: "absolute" | "relative";
}) {
    const { timeZone, now } = useTimeContext();
    const absolute = formatAbsolute(at, timeZone);
    if (format === "absolute") return <time dateTime={toIsoTimestamp(at)}>{absolute}</time>;
    return (
        <time dateTime={toIsoTimestamp(at)} title={absolute}>
            {formatRelative(at, now)}
        </time>
    );
}
