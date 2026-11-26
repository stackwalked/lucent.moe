import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { EpochMs } from "@lucent/core/scalars";
import { decideRecoveries, decideSupportMove } from "../src/record/support.rules.ts";

test.each([
    ["a newly seen build the release covers moves nothing", false, "first_report", true, null],
    [
        "a newly seen build the release doesn't cover is a drop",
        false,
        "first_report",
        false,
        "drop",
    ],
    ["a start never records a rise", true, "first_report", true, null],
    ["a start during a drop records nothing more", true, "first_report", false, null],
    [
        "a fact set promotion covering the drop's builds is a rise",
        true,
        "fact_promotion",
        true,
        "rise",
    ],
    [
        "a fact set promotion that doesn't cover them leaves the drop",
        true,
        "fact_promotion",
        false,
        null,
    ],
    ["a fact set promotion never records a drop", false, "fact_promotion", false, null],
    ["a release covering the drop's builds is a rise", true, "release_promotion", true, "rise"],
    [
        "a release not covering the drop's builds leaves the drop",
        true,
        "release_promotion",
        false,
        null,
    ],
    [
        "a release not covering the game's builds is a drop",
        false,
        "release_promotion",
        false,
        "drop",
    ],
    ["a release covering the game's builds moves nothing", false, "release_promotion", true, null],
] as const)("%s", (_name, down, event, covered, expected) => {
    expect(decideSupportMove({ down, event, covered }).value).toBe(expected);
});

const at = (ms: number) => EpochMs.parse(ms);
const drop = (ms: number) => ({ supported: false, changedAt: at(ms) });
const rise = (ms: number) => ({ supported: true, changedAt: at(ms) });

function recoveries(params: Parameters<typeof decideRecoveries>[0]) {
    const decided = decideRecoveries(params);
    invariant(decided.ok, "recoveries are never refused");
    return decided.value;
}

test("each drop pairs with the rise after it, newest first, with its duration", () => {
    expect(
        recoveries({
            changes: [drop(100), rise(400), drop(1_000), rise(1_050)],
            txNow: at(2_000),
        }),
    ).toEqual([
        { startedAt: at(1_000), endedAt: at(1_050), latency: { state: "covered", latencyMs: 50 } },
        { startedAt: at(100), endedAt: at(400), latency: { state: "covered", latencyMs: 300 } },
    ]);
});

test("a drop with no rise yet is open since the drop", () => {
    expect(recoveries({ changes: [drop(100)], txNow: at(700) })).toEqual([
        { startedAt: at(100), endedAt: null, latency: { state: "waiting", waitingMs: 600 } },
    ]);
});

test("a rise the read's bound cut its drop from is not a recovery", () => {
    expect(recoveries({ changes: [rise(50), drop(100), rise(150)], txNow: at(700) })).toEqual([
        { startedAt: at(100), endedAt: at(150), latency: { state: "covered", latencyMs: 50 } },
    ]);
});

test("no changes is no history", () => {
    expect(recoveries({ changes: [], txNow: at(700) })).toEqual([]);
});
