import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { createSnapshot, type SnapshotRead } from "../src/features/status/snapshot.ts";

const answered = (value: string, at: number): SnapshotRead<string> => ({
    ok: true,
    value,
    at: EpochMs.parse(at),
});
const down: SnapshotRead<string> = { ok: false };

test("with no answer from platform yet, status is unavailable", async () => {
    const snapshot = createSnapshot<string>();
    expect(await snapshot(async () => down)).toEqual({ state: "unavailable" });
});

test("while platform answers the page is current, and once it stops the last answer is served with its time", async () => {
    const snapshot = createSnapshot<string>();
    expect(await snapshot(async () => answered("first", 1_000))).toEqual({
        state: "current",
        value: "first",
        at: EpochMs.parse(1_000),
    });
    expect(await snapshot(async () => answered("second", 2_000))).toMatchObject({
        state: "current",
        value: "second",
    });
    expect(await snapshot(async () => down)).toEqual({
        state: "stale",
        value: "second",
        at: EpochMs.parse(2_000),
    });
    expect(await snapshot(async () => down)).toEqual({
        state: "stale",
        value: "second",
        at: EpochMs.parse(2_000),
    });
    expect(await snapshot(async () => answered("third", 3_000))).toMatchObject({
        state: "current",
        value: "third",
    });
});
