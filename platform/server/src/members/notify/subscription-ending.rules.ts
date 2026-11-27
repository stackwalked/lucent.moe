import { type Ok, ok } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";

const DAY_MS = 24 * 60 * 60_000;

// The two moments before an entitlement's end at which its holder is told, earliest first.
export const ENDING_MARKS = [
    { mark: "7d", beforeMs: 7 * DAY_MS },
    { mark: "1d", beforeMs: DAY_MS },
] as const;
export type EndingMark = (typeof ENDING_MARKS)[number]["mark"];

export type EndingPlan = {
    // The mark to tell the holder about, or none.
    readonly file: EndingMark | null;
    // Every mark now reached and not yet recorded for this end date: the filed one, and an
    // earlier one that was passed unseen (the job was away, or the end was set less than a week
    // out), so it is not told late after the later one.
    readonly record: readonly EndingMark[];
};

// Which of an entitlement's marks are due at `now`, given the ones already recorded for its
// current end date (`sent`). A mark is due from its moment until the end; once a later mark is
// recorded an earlier one never is. The holder is told once per run at most, of the latest mark
// reached, so an entitlement first seen a day from its end gets one notice, not two.
export function decideEndingNotice(params: {
    readonly now: EpochMs;
    readonly validUntil: EpochMs;
    readonly sent: readonly EndingMark[];
}): Ok<EndingPlan> {
    const { now, validUntil, sent } = params;
    if (now >= validUntil) return ok({ file: null, record: [] });
    const reached = ENDING_MARKS.filter(({ beforeMs }) => now >= validUntil - beforeMs);
    const latestSent = ENDING_MARKS.findLast(({ mark }) => sent.includes(mark));
    const due = reached.filter(
        ({ mark }) =>
            !sent.includes(mark) &&
            (latestSent === undefined ||
                ENDING_MARKS.indexOf(latestSent) < ENDING_MARKS.findIndex((m) => m.mark === mark)),
    );
    const latest = due.at(-1);
    return ok({
        file: latest === undefined ? null : latest.mark,
        record: due.map(({ mark }) => mark),
    });
}

export const ENDING_WINDOW_MS = ENDING_MARKS[0].beforeMs;
