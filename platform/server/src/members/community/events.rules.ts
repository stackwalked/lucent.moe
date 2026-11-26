import { err, ok, type Result } from "@lucent/core/result";

// Streams are open connections held in memory, so they are bounded: per account, so one account
// cannot hold the process's connections, and overall, so all of them together cannot.
export const MAX_STREAMS_PER_ACCOUNT = 4;
export const MAX_STREAMS = 2_000;

export type StreamRefusal = { readonly code: "SERVICE_UNAVAILABLE" };

export function decideStreamAdmission(params: {
    readonly accountStreams: number;
    readonly totalStreams: number;
}): Result<null, StreamRefusal> {
    if (params.accountStreams >= MAX_STREAMS_PER_ACCOUNT) {
        return err({ code: "SERVICE_UNAVAILABLE" });
    }
    if (params.totalStreams >= MAX_STREAMS) return err({ code: "SERVICE_UNAVAILABLE" });
    return ok(null);
}

// The roster is the people part of presence: who is online, capped, so a crowded night costs the
// same frame as a quiet one. Rows arrive with every fact the filter needs; the decision is pure
// so the cap and the hiding are table-tested. `online` in the event stays the true count of
// everyone connected, whoever the roster leaves out.
export const ROSTER_CAP = 50;

export type RosterRow = {
    readonly username: string;
    readonly avatar: string | null;
    readonly inGame: boolean;
    // False when the account hides its last seen or its profile is private: it is never named.
    readonly shown: boolean;
};

export type RosterEntry = {
    readonly username: string;
    readonly avatar: string | null;
    readonly inGame: boolean;
};

export function decideRoster(
    rows: readonly RosterRow[],
    cap: number = ROSTER_CAP,
): readonly RosterEntry[] {
    return rows
        .filter((row) => row.shown)
        .slice(0, cap)
        .map(({ username, avatar, inGame }) => ({ username, avatar, inGame }));
}
