import { ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

export type CountryPlan = {
    // The country to note as seen, or null when the file didn't place the address.
    readonly record: string | null;
    // A risk signal: the account signed in from a country it never signed in from before.
    readonly newCountry: boolean;
};

// The first country an account is seen in is where it lives, learned without a mark; any later
// country it was never seen in is a signal for review. An address the file can't place says
// nothing either way.
export function decideSignInCountry(params: {
    readonly known: readonly string[];
    readonly country: string | null;
}): Result<CountryPlan, never> {
    const { known, country } = params;
    if (country === null) return ok({ record: null, newCountry: false });
    return ok({ record: country, newCountry: known.length > 0 && !known.includes(country) });
}

const UNJUDGED_KEEP_MS = 24 * 60 * 60 * 1_000;

// Without a country file nothing can be judged; a sign-in older than this is dropped unjudged,
// so raw addresses don't pile up while geo is off.
export function decideUnjudgedCutoff(txNow: EpochMs): Result<EpochMs, never> {
    return ok(EpochMs.parse(Math.max(0, txNow - UNJUDGED_KEEP_MS)));
}
