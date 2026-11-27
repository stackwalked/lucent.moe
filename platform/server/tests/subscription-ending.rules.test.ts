import { expect, test } from "bun:test";
import { ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import {
    decideEndingNotice,
    type EndingMark,
} from "../src/members/notify/subscription-ending.rules.ts";

const DAY = 24 * 60 * 60_000;
const END = EpochMs.parse(100 * DAY);
const at = (beforeEnd: number) => EpochMs.parse(END - beforeEnd);

test.each<
    [
        string,
        number,
        readonly EndingMark[],
        { file: EndingMark | null; record: readonly EndingMark[] },
    ]
>([
    ["more than 7 days out nothing is due", 7 * DAY + 1, [], { file: null, record: [] }],
    ["at 7 days the first mark is due", 7 * DAY, [], { file: "7d", record: ["7d"] }],
    [
        "between the marks the first is still due if it was missed",
        3 * DAY,
        [],
        { file: "7d", record: ["7d"] },
    ],
    [
        "between the marks nothing is due once the first was sent",
        3 * DAY,
        ["7d"],
        { file: null, record: [] },
    ],
    [
        "just before 1 day nothing is due once the first was sent",
        DAY + 1,
        ["7d"],
        { file: null, record: [] },
    ],
    ["at 1 day the second mark is due", DAY, ["7d"], { file: "1d", record: ["1d"] }],
    [
        "first seen within a day gets one notice, and the passed mark is recorded unsent",
        DAY - 1,
        [],
        { file: "1d", record: ["7d", "1d"] },
    ],
    ["both sent: nothing", 1, ["7d", "1d"], { file: null, record: [] }],
    [
        "the second sent without the first: the first is never told late",
        1,
        ["1d"],
        { file: null, record: [] },
    ],
    ["at the end nothing is due", 0, [], { file: null, record: [] }],
])("%s", (_name, beforeEnd, sent, expected) => {
    expect(decideEndingNotice({ now: at(beforeEnd), validUntil: END, sent })).toEqual(ok(expected));
});

test("an entitlement past its end is not told", () => {
    expect(
        decideEndingNotice({ now: EpochMs.parse(END + DAY), validUntil: END, sent: [] }),
    ).toEqual(ok({ file: null, record: [] }));
});

test("an extended end is a new date: what was sent for the old one does not count", () => {
    // The caller reads `sent` for the current end date only; with none sent for the new date, the
    // marks the new date has reached are due again.
    const extended = EpochMs.parse(END + 30 * DAY);
    expect(
        decideEndingNotice({
            now: EpochMs.parse(extended - 6 * DAY),
            validUntil: extended,
            sent: [],
        }),
    ).toEqual(ok({ file: "7d", record: ["7d"] }));
});
