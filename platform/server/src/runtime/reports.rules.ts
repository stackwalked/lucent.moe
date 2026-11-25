import { err, ok, type Result } from "@lucent/core/result";

type Code<C extends string> = { readonly code: C };

// How many events one session may have stored. A healthy module reports a handful of health
// events a minute and crashes rarely (a crash usually ends the game); past the cap a batch is
// still acked, with the events it couldn't keep left out of `accepted`, so a module stuck in a
// loop costs a counter, not rows.
export const MAX_REPORTS_PER_SESSION = 1_024;

export type ReportsAnswer = {
    // The sequence the ack goes out at.
    readonly sequence: bigint;
    // Null for a retry, answered from its receipt; else how many of the batch to store.
    readonly store: number | null;
};

// A new batch must be newer than any the route accepted; it is answered at the route's next
// sequence, its events stored up to the session's cap. A retry is answered at the sequence its
// receipt names, which must still be the last the route sent: one answered after it means the
// module moved on.
export function decideReportsAnswer(params: {
    readonly frameSequence: bigint;
    readonly inSequence: bigint;
    readonly outSequence: bigint;
    readonly replayed: bigint | null;
    readonly stored: number;
    readonly batch: number;
}): Result<ReportsAnswer, Code<"STALE_SEQUENCE">> {
    if (params.replayed !== null) {
        return params.replayed === params.outSequence - 1n
            ? ok({ sequence: params.replayed, store: null })
            : err({ code: "STALE_SEQUENCE" });
    }
    if (params.frameSequence <= params.inSequence) return err({ code: "STALE_SEQUENCE" });
    const room = Math.max(0, MAX_REPORTS_PER_SESSION - params.stored);
    return ok({ sequence: params.outSequence, store: Math.min(params.batch, room) });
}
