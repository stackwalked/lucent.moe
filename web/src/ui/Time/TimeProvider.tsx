import { systemClock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import type { EpochMs } from "@lucent/core/scalars";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { usableTimeZone } from "./format.ts";

type TimeContext = { readonly timeZone: string; readonly now: EpochMs };

const MINUTE = 60_000;

const TimeContext = createContext<TimeContext | null>(null);

// What <Time> reads: the zone to show in and the moment "ago" counts from. `now` is the server's
// at first, so server and browser render the same text; the browser then moves it once a minute.
export function TimeProvider({
    now,
    timeZone = "UTC",
    children,
}: {
    readonly now: EpochMs;
    readonly timeZone?: string;
    readonly children: ReactNode;
}) {
    const [current, setCurrent] = useState(now);
    useEffect(() => {
        const timer = setInterval(() => setCurrent(systemClock.now()), MINUTE);
        return () => clearInterval(timer);
    }, []);
    return (
        <TimeContext value={{ timeZone: usableTimeZone(timeZone), now: current }}>
            {children}
        </TimeContext>
    );
}

export function useTimeContext(): TimeContext {
    const context = useContext(TimeContext);
    invariant(context !== null, "Time needs a TimeProvider above it");
    return context;
}
