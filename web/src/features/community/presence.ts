import { trySync } from "@lucent/core/contain";
import { useEffect, useState } from "react";

export type RosterEntry = {
    readonly username: string;
    readonly avatar: string | null;
    readonly inGame: boolean;
};

export type Presence = {
    // Everyone connected, the roster's hidden accounts included.
    readonly online: number;
    // At most 50 of them, those who may be named.
    readonly roster: readonly RosterEntry[];
};

const EVENTS_PATH = "/community/events";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEntry(value: unknown): RosterEntry | null {
    if (!isRecord(value)) return null;
    const { username, avatar, inGame } = value;
    if (typeof username !== "string") return null;
    if (avatar !== null && typeof avatar !== "string") return null;
    if (typeof inGame !== "boolean") return null;
    return { username, avatar, inGame };
}

// A `presence` frame's data as platform writes it ({ online, roster }); anything else is no
// frame at all.
export function parsePresence(raw: string): Presence | null {
    const parsed = trySync(
        (): unknown => JSON.parse(raw),
        () => null,
    );
    if (!parsed.ok) return null;
    const value = parsed.value;
    if (!isRecord(value)) return null;
    const { online, roster } = value;
    if (typeof online !== "number" || !Array.isArray(roster)) return null;
    const entries: RosterEntry[] = [];
    for (const item of roster) {
        const entry = toEntry(item);
        if (entry === null) return null;
        entries.push(entry);
    }
    return { online, roster: entries };
}

// Who is here now, for as long as the page holds it: one EventSource opened on mount and
// closed on unmount. Null until the first frame and again whenever the stream drops (the
// browser reconnects by itself), so nothing stale is shown as live.
export function usePresence(): Presence | null {
    const [presence, setPresence] = useState<Presence | null>(null);
    useEffect(() => {
        const source = new EventSource(EVENTS_PATH);
        source.addEventListener("presence", (event) => {
            setPresence(parsePresence(event.data));
        });
        source.addEventListener("error", () => setPresence(null));
        return () => source.close();
    }, []);
    return presence;
}
