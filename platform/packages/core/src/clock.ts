import { type EpochMs, isEpochMs } from "./brands.ts";
import { invariant } from "./contain.ts";

export type Clock = {
    readonly now: () => EpochMs;
};

// The one ambient clock (ast-grep: ts-no-ambient-effects); everything else takes a Clock.
export const systemClock: Clock = {
    now: () => {
        const now = Date.now();
        invariant(isEpochMs(now), "the system clock reads after 1970");
        return now;
    },
};

export function toIsoTimestamp(at: EpochMs): string {
    return new Date(at).toISOString();
}
