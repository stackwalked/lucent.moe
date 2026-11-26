import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import {
    countWord,
    mergeQueue,
    type QueueKind,
    type QueueRow,
    queueKinds,
    waitedLong,
} from "../src/features/admin/queue/merge.ts";

const row = (kind: QueueKind, id: string, at: number): QueueRow => ({
    kind,
    id,
    title: id,
    context: "",
    who: null,
    at: EpochMs.parse(at),
});

test("the merge puts the oldest first across kinds and keeps ties in a fixed order", () => {
    const merged = mergeQueue({
        tickets: [row("tickets", "t2", 30), row("tickets", "t1", 10)],
        reports: [row("reports", "r1", 20)],
        flags: [row("flags", "f1", 20), row("flags", "f0", 5)],
        listings: [row("listings", "l1", 30)],
    });
    expect(merged.map((r) => r.id)).toEqual(["f0", "t1", "r1", "f1", "t2", "l1"]);
});

test("a kind with nothing loaded adds nothing, and nothing at all is an empty list", () => {
    expect(mergeQueue({})).toEqual([]);
    expect(mergeQueue({ applications: [] }).length).toBe(0);
});

test.each([
    ["every permission", () => true, ["tickets", "applications", "reports", "flags", "listings"]],
    ["only tickets:reply", (a: string) => a === "tickets:reply", ["tickets"]],
    ["only moderation:remove", (a: string) => a === "moderation:remove", ["reports", "listings"]],
    ["none", () => false, []],
] as const)("the kinds a viewer with %s may see", (_name, allowed, kinds) => {
    expect(queueKinds(allowed)).toEqual(kinds);
});

test("a count is the loaded rows, with a plus when there is more", () => {
    expect(countWord(3, "all")).toBe("3");
    expect(countWord(25, "partial")).toBe("25+");
});

test("waiting turns long after a day", () => {
    const now = EpochMs.parse(10 * 86_400_000);
    expect(waitedLong(EpochMs.parse(now - 86_400_000), now)).toBe(false);
    expect(waitedLong(EpochMs.parse(now - 86_400_001), now)).toBe(true);
});
