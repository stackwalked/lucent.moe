import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { usableTimeZone } from "./ui/Time/format.ts";

// Times show in the viewer's own zone. The browser reports it in a plain display-preference
// cookie on its first page; until then the server renders UTC, and the browser's own zone takes
// over from the next navigation.
export const TIME_ZONE_COOKIE = "lucent-tz";
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

export const currentTimeZone = createIsomorphicFn()
    .server((): string => usableTimeZone(getCookie(TIME_ZONE_COOKIE)))
    .client((): string => usableTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));

export async function reportTimeZone(now: number): Promise<void> {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const stored = await cookieStore.get(TIME_ZONE_COOKIE);
    if (stored?.value === zone) return;
    await cookieStore.set({
        name: TIME_ZONE_COOKIE,
        value: zone,
        path: "/",
        expires: now + YEAR_MS,
        sameSite: "lax",
    });
}
