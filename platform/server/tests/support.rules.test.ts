import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { EpochMs } from "@lucent/core/scalars";
import { decideRecoveries, decideSupportWrite } from "../src/record/support.rules.ts";

test.each([
    ["a product with no status writes nothing", null, null, null],
    ["a recorded product with no status now keeps its state", false, null, null],
    ["an unchanged state writes nothing", true, true, null],
    ["an unchanged drop writes nothing", false, false, null],
    [
        "a first supported state is stored without a change",
        null,
        true,
        { supported: true, change: false },
    ],
    ["a first unsupported state is a drop", null, false, { supported: false, change: true }],
    ["supported to not supported is a drop", true, false, { supported: false, change: true }],
    ["not supported to supported is a rise", false, true, { supported: true, change: true }],
] as const)("%s", (_name, recorded, now, expected) => {
    expect(decideSupportWrite({ recorded, now }).value).toEqual(expected);
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
