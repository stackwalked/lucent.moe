import { expect, test } from "bun:test";
import { decideProductLifecycle } from "../src/lifecycle.rules.ts";

test.each([
    ["announced", [true, true, true], false, "NOT_FOUND"],
    ["seed", [false, true, false], true, null],
    ["live", [true, true, true], true, null],
    ["retired", [false, true, true], false, "RELEASE_UNAVAILABLE"],
] as const)(
    "%s gates visibility, issuance and starts independently",
    (state, listed, issuable, startRefusal) => {
        for (const index of [0, 1, 2] as const) {
            const holding = (["none", "current", "past"] as const)[index];
            expect(decideProductLifecycle(state, holding).value).toEqual({
                listed: listed[index],
                issuable,
                startRefusal,
            });
        }
    },
);
