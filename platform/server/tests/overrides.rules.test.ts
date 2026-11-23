import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { decideOverrideChange } from "../src/facts/overrides.rules.ts";
import { decideUpdateDayLatency } from "../src/facts/updates.rules.ts";
import { decideReviewOutcome } from "../src/risk/review.rules.ts";

const known = { features: [0x11n, 0x22n], capabilities: [0x33n] };
const current = [{ kind: "feature" as const, key: 0x22n }];

test.each([
    ["an undeclared feature", "feature", 0x33n, true, 4n, { code: "UNKNOWN_TARGET" }],
    ["a capability key used as a feature", "feature", 0x44n, true, 4n, { code: "UNKNOWN_TARGET" }],
    [
        "a feature key used as a capability",
        "capability",
        0x11n,
        true,
        4n,
        { code: "UNKNOWN_TARGET" },
    ],
    ["a feature on", "feature", 0x11n, true, 4n, { change: "set", revision: 5n }],
    ["a feature on, first switch", "feature", 0x11n, true, null, { change: "set", revision: 1n }],
    ["a feature already off", "feature", 0x22n, true, 4n, { change: "none" }],
    ["an off feature back on", "feature", 0x22n, false, 4n, { change: "clear", revision: 5n }],
    ["a capability already on", "capability", 0x33n, false, 4n, { change: "none" }],
    ["a capability on", "capability", 0x33n, true, 4n, { change: "set", revision: 5n }],
] as const)("switching %s off=%s", (_, kind, key, off, revision, expected) => {
    const plan = decideOverrideChange({ known, current, revision, target: { kind, key }, off });
    expect(plan.ok ? plan.value : plan.error).toEqual(expected);
});

const reported = EpochMs.parse(1_000_000);

test.each([
    ["covered an hour after the report", 3_600_000, { state: "covered", latencyMs: 3_600_000 }],
    ["covered before the report", -5_000, { state: "covered", latencyMs: 0 }],
    ["not covered yet", null, { state: "waiting", waitingMs: 60_000 }],
] as const)("a build %s", (_, coveredAfter, expected) => {
    const latency = decideUpdateDayLatency({
        firstReportedAt: reported,
        firstCoveredAt: coveredAfter === null ? null : EpochMs.parse(reported + coveredAfter),
        txNow: EpochMs.parse(reported + 60_000),
    });
    expect(latency).toEqual({ ok: true, value: expected });
});

test.each([
    ["a missing item", null, "NOT_FOUND"],
    ["a decided item", { decidedAt: EpochMs.parse(5) }, "ALREADY_DECIDED"],
    ["an open item", { decidedAt: null }, null],
] as const)("deciding %s", (_, item, code) => {
    const decided = decideReviewOutcome(item);
    expect(decided.ok ? null : decided.error.code).toBe(code);
});
