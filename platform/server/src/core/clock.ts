import { EpochMs } from "./scalars.ts";

export type Clock = {
    readonly now: () => EpochMs;
};

// The one ambient clock (ast-grep: ts-no-ambient-effects); everything else takes a Clock.
export const systemClock: Clock = {
    now: () => EpochMs.parse(Date.now()),
};

export function toIsoTimestamp(at: EpochMs): string {
    return new Date(at).toISOString();
}
