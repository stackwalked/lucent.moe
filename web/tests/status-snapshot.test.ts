import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { createSnapshot, type SnapshotRead } from "../src/features/status/snapshot.ts";

// Platform as the holder sees it: answers in turn, and counts how often it was asked.
function world() {
    let now = 1_000_000;
    let asked = 0;
    let answer: SnapshotRead<string> = { ok: false };
    let release: (() => void) | null = null;
    let held = false;
    const snapshot = createSnapshot<string>({
        clock: { now: () => EpochMs.parse(now) },
        read: async () => {
            asked += 1;
            if (held) await new Promise<void>((resolve) => (release = resolve));
            return answer;
        },
    });
    return {
        snapshot,
        answer: (value: string, at: number) => {
            answer = { ok: true, value, at: EpochMs.parse(at) };
        },
        down: () => {
            answer = { ok: false };
        },
        pass: (ms: number) => {
            now += ms;
        },
        hold: () => {
            held = true;
        },
        let: () => {
            held = false;
            release?.();
        },
        asked: () => asked,
    };
}

test("with no answer from platform yet, status is unavailable", async () => {
    const w = world();
    expect(await w.snapshot()).toEqual({ state: "unavailable" });
});

test("a read younger than 15 seconds is served without asking platform, and not as a failure", async () => {
    const w = world();
    w.answer("first", 500);
    expect(await w.snapshot()).toEqual({
        state: "current",
        value: "first",
        at: EpochMs.parse(500),
    });
    w.down();
    w.pass(10_000);
    expect(await w.snapshot()).toEqual({
        state: "current",
        value: "first",
        at: EpochMs.parse(500),
    });
    expect(w.asked()).toBe(1);
    w.answer("second", 900);
    w.pass(5_000);
    expect(await w.snapshot()).toEqual({
        state: "current",
        value: "second",
        at: EpochMs.parse(900),
    });
    expect(w.asked()).toBe(2);
});

test("once platform stops answering the last read is served with its own time", async () => {
    const w = world();
    w.answer("first", 500);
    await w.snapshot();
    w.down();
    w.pass(20_000);
    expect(await w.snapshot()).toEqual({ state: "stale", value: "first", at: EpochMs.parse(500) });
    w.pass(20_000);
    expect(await w.snapshot()).toEqual({ state: "stale", value: "first", at: EpochMs.parse(500) });
    expect(w.asked()).toBe(3);
});

test("concurrent requests share one read in flight", async () => {
    const w = world();
    w.answer("first", 500);
    w.hold();
    const waiting = [w.snapshot(), w.snapshot(), w.snapshot()];
    await Promise.resolve();
    w.let();
    for (const shown of await Promise.all(waiting)) {
        expect(shown).toEqual({ state: "current", value: "first", at: EpochMs.parse(500) });
    }
    expect(w.asked()).toBe(1);
});
