import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { decideMailClaim, decideMailRetry } from "../src/members/notify/mail.rules.ts";

test.each([
    ["brevo", 839_999, 11, true],
    ["brevo", 840_000, 1, false],
    ["resend", 86_339_999, 11, true],
    ["resend", 86_340_000, 1, false],
    ["resend", 1, 12, false],
] as const)("%s replay at %d after %d attempts", (provider, elapsed, attempts, allowed) => {
    expect(
        decideMailClaim({
            provider,
            now: EpochMs.parse(1000 + elapsed),
            first: EpochMs.parse(1000),
            attempts,
            sameBinding: true,
        }).ok,
    ).toBe(allowed);
});
test.each([
    [1000, 5999, 1, false],
    [1000, 6000, 1, false],
    [1000, 6001, 1, true],
    [1000, 999999, 12, false],
] as const)("retry from %d before cutoff %d on attempt %d", (now, stopAt, attempt, allowed) => {
    expect(
        decideMailRetry({
            now: EpochMs.parse(now),
            stopAt: EpochMs.parse(stopAt),
            first: EpochMs.parse(1000),
            attempt,
        }).ok,
    ).toBe(allowed);
});
