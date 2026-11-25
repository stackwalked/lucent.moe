import { err, ok, type Result } from "@lucent/core/result";

type Code<C extends string> = { readonly code: C };

// How many events one session may have stored. A healthy module reports a handful of health
// events a minute and crashes rarely (a crash usually ends the game); past the cap a batch is
// still acked, with the events it couldn't keep left out of `accepted`, so a module stuck in a
// loop costs a counter, not rows.
export const MAX_REPORTS_PER_SESSION = 1_024;

// How many one account may have stored across the sessions it opened in the last day, since a
// loop that reopens its session would start each one with a fresh per-session cap. Counted from
// the sessions' own counters, by when each session opened.
export const MAX_REPORTS_PER_ACCOUNT_DAY = 8_192;

export const REPORTS_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type ReportsAnswer = {
    // The sequence the ack goes out at.
    readonly sequence: bigint;
    // Null for a retry, answered from its receipt; else how many of the batch to store.
    readonly store: number | null;
};

// A new batch must be newer than any the route accepted; it is answered at the route's next
// sequence, its events stored up to whichever cap is nearer, the session's or the account's. A
// retry is answered at the sequence its receipt names, which must still be the last the route
// sent: one answered after it means the module moved on.
export function decideReportsAnswer(params: {
    readonly frameSequence: bigint;
    readonly inSequence: bigint;
    readonly outSequence: bigint;
    readonly replayed: bigint | null;
    // Stored for this session, and for the account's sessions of the last day (this one included).
    readonly stored: number;
    readonly accountStored: number;
    readonly batch: number;
}): Result<ReportsAnswer, Code<"STALE_SEQUENCE">> {
    if (params.replayed !== null) {
        return params.replayed === params.outSequence - 1n
            ? ok({ sequence: params.replayed, store: null })
            : err({ code: "STALE_SEQUENCE" });
    }
    if (params.frameSequence <= params.inSequence) return err({ code: "STALE_SEQUENCE" });
    const room = Math.max(
        0,
        Math.min(
            MAX_REPORTS_PER_SESSION - params.stored,
            MAX_REPORTS_PER_ACCOUNT_DAY - params.accountStored,
        ),
    );
    return ok({ sequence: params.outSequence, store: Math.min(params.batch, room) });
}
