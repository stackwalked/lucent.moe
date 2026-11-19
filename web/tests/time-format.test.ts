import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { formatAbsolute, formatRelative, usableTimeZone } from "../src/ui/Time/format.ts";

const at = (ms: number) => EpochMs.parse(ms);
const NOV_18_2026_1405_UTC = Date.UTC(2026, 10, 18, 14, 5);

test("an absolute time reads day first in 24-hour time, without seconds", () => {
    expect(formatAbsolute(at(NOV_18_2026_1405_UTC), "UTC")).toBe("18 Nov 2026, 14:05");
});

test("an absolute time is shown in the zone given, across a date change", () => {
    expect(formatAbsolute(at(NOV_18_2026_1405_UTC), "Asia/Tokyo")).toBe("18 Nov 2026, 23:05");
    expect(formatAbsolute(at(NOV_18_2026_1405_UTC), "Pacific/Auckland")).toBe("19 Nov 2026, 03:05");
});

test("midnight is 00:00, not 24:00, and September keeps its three letters", () => {
    expect(formatAbsolute(at(Date.UTC(2026, 8, 1, 0, 0)), "UTC")).toBe("1 Sep 2026, 00:00");
});

test("less than a minute ago, or ahead of now, is just now", () => {
    const now = at(NOV_18_2026_1405_UTC);
    expect(formatRelative(at(now - 59_999), now)).toBe("just now");
    expect(formatRelative(now, now)).toBe("just now");
    expect(formatRelative(at(now + 5 * 60_000), now)).toBe("just now");
});

test("each unit rounds down and switches exactly at its boundary", () => {
    const now = at(NOV_18_2026_1405_UTC);
    const ago = (ms: number) => formatRelative(at(now - ms), now);
    expect(ago(60_000)).toBe("1m ago");
    expect(ago(60 * 60_000 - 1)).toBe("59m ago");
    expect(ago(60 * 60_000)).toBe("1h ago");
    expect(ago(24 * 3_600_000 - 1)).toBe("23h ago");
    expect(ago(24 * 3_600_000)).toBe("1d ago");
    expect(ago(3 * 24 * 3_600_000 + 5 * 3_600_000)).toBe("3d ago");
});

test("a time zone the browser made up shows UTC instead of failing the page", () => {
    expect(usableTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(usableTimeZone("Mars/Olympus_Mons")).toBe("UTC");
    expect(usableTimeZone(undefined)).toBe("UTC");
});
