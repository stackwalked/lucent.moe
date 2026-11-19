import { trySync } from "@lucent/core/contain";
import type { EpochMs } from "@lucent/core/scalars";
import { UI_COPY } from "../copy.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// "18 nov 2026, 14:05": day first, all copy lowercase, 24-hour, no seconds. Built from parts because en-GB spells
// September "Sept" and its separators have changed between ICU versions; en-US's short months
// are stable, and hourCycle h23 keeps midnight 00:xx rather than 24:xx.
export function formatAbsolute(at: EpochMs, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((p) => p.type === type)?.value ?? "";
    return `${part("day")} ${part("month").toLowerCase()} ${part("year")}, ${part("hour")}:${part("minute")}`;
}

// Whole units, rounded down, so "1h ago" never shows before an hour has passed. A time ahead of
// `now` (clock skew between server and browser) reads as just now.
export function formatRelative(at: EpochMs, now: EpochMs): string {
    const elapsed = now - at;
    if (elapsed < MINUTE) return UI_COPY.justNow;
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ${UI_COPY.ago}`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ${UI_COPY.ago}`;
    return `${Math.floor(elapsed / DAY)}d ${UI_COPY.ago}`;
}

// A zone the viewer's browser reported (the lucent-tz cookie), checked before Intl sees it: an
// unknown name is a RangeError there. Anything unusable shows UTC.
export function usableTimeZone(raw: string | undefined): string {
    if (raw === undefined || raw.length > 64) return "UTC";
    const checked = trySync(
        () => new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone,
        () => "UTC",
    );
    return checked.ok ? checked.value : "UTC";
}
