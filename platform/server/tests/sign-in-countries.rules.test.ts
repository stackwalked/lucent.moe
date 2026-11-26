import { describe, expect, test } from "bun:test";
import { ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import {
    decideSignInCountry,
    decideUnjudgedCutoff,
} from "../src/members/support/sign-in-countries.rules.ts";

describe("decideSignInCountry", () => {
    const cases: readonly [string, readonly string[], string | null, string | null, boolean][] = [
        ["the first country is learned without a signal", [], "FR", "FR", false],
        ["a known country is seen again without a signal", ["FR", "DE"], "DE", "DE", false],
        ["a country never seen before is a signal", ["FR"], "JP", "JP", true],
        ["an address the file can't place says nothing", ["FR"], null, null, false],
        ["an unplaced first sign-in learns nothing", [], null, null, false],
    ];
    for (const [name, known, country, record, newCountry] of cases) {
        test(name, () => {
            expect(decideSignInCountry({ known, country })).toEqual(ok({ record, newCountry }));
        });
    }
});

describe("decideUnjudgedCutoff", () => {
    test("unjudged sign-ins are kept a day", () => {
        const day = 24 * 60 * 60 * 1_000;
        expect(decideUnjudgedCutoff(EpochMs.parse(3 * day))).toEqual(ok(EpochMs.parse(2 * day)));
    });
});
