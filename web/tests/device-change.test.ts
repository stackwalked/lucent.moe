import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { approvalChange, mayRemove } from "../src/features/devices/change.ts";

const NEXT_WEEK = EpochMs.parse(1_800_000_000_000);

test("approving below the limit adds a pc, whatever the window says", () => {
    expect(approvalChange({ devices: [], limit: 1, replaceableFrom: NEXT_WEEK })).toEqual({
        kind: "adds",
    });
});

test("approving at the limit replaces the pc when the window is open, and waits when it isn't", () => {
    expect(approvalChange({ devices: [{}], limit: 1, replaceableFrom: null })).toEqual({
        kind: "replaces",
    });
    expect(approvalChange({ devices: [{}], limit: 1, replaceableFrom: NEXT_WEEK })).toEqual({
        kind: "waits",
        until: NEXT_WEEK,
    });
});

test("removing a pc is offered only while the window is open", () => {
    expect(mayRemove({ devices: [{}], limit: 1, replaceableFrom: null })).toBe(true);
    expect(mayRemove({ devices: [{}], limit: 1, replaceableFrom: NEXT_WEEK })).toBe(false);
});
