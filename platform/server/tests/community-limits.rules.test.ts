import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import {
    decidePostRate,
    decideReportLimit,
    type LimitRefusal,
} from "../src/members/community/limits.rules.ts";

const refused = (limit: LimitRefusal["limit"]) => err({ code: "LIMIT_REACHED", limit });

test.each([
    ["reports", decideReportLimit, 19, ok(null)],
    ["reports", decideReportLimit, 20, refused("reports")],
    ["reports", decideReportLimit, 99, refused("reports")],
    ["posts", decidePostRate, 0, ok(null)],
    ["posts", decidePostRate, 9, ok(null)],
    ["posts", decidePostRate, 10, refused("posts")],
] as const)("the %s limit at a count of %d", (_name, decide, count, expected) => {
    expect(decide(count)).toEqual(expected);
});
