import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import { decideSetAvatar } from "../src/members/community/avatars.rules.ts";
import type { Restriction } from "../src/members/community/standing.rules.ts";

const now = EpochMs.parse(1_800_000_000_000);
const later = EpochMs.parse(1_800_000_600_000);
const earlier = EpochMs.parse(1_799_999_400_000);
const cs2 = ProductId.parse("cs2");

const barred: Restriction = { kind: "barred", productId: null, endsAt: later };

test.each([
    ["no restriction, profile standing", [], false, ok(null)],
    [
        "muted only closes conversation",
        [{ kind: "muted", productId: null, endsAt: null }],
        false,
        ok(null),
    ],
    [
        "a bar in one product leaves the profile open",
        [{ kind: "barred", productId: cs2, endsAt: null }],
        false,
        ok(null),
    ],
    [
        "an expired bar is no bar",
        [{ kind: "barred", productId: null, endsAt: earlier }],
        false,
        ok(null),
    ],
    [
        "a bar everywhere closes the profile",
        [barred],
        false,
        err({ code: "POSTING_RESTRICTED", kind: "barred", productId: null, endsAt: later }),
    ],
    ["a removed profile takes no picture", [], true, err({ code: "PROFILE_REMOVED" })],
    [
        "the restriction is named first when both apply",
        [barred],
        true,
        err({ code: "POSTING_RESTRICTED", kind: "barred", productId: null, endsAt: later }),
    ],
] as const)("%s", (_name, restrictions, profileRemoved, expected) => {
    expect(decideSetAvatar({ restrictions, profileRemoved, now })).toEqual(expected);
});
