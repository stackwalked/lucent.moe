import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { decideRefresh } from "../src/identity/devices/sign-in.rules.ts";

const now = EpochMs.parse(101);
const parent = Uint8Array.of(1);
const successor = {
    jkt: "key",
    revoked_at: null,
    expires_at: EpochMs.parse(102),
    rotated_at: EpochMs.parse(91),
    has_live: true,
    live_parent: parent,
};
test.each([
    ["unused", { rotated_at: null }, "rotate"],
    ["last millisecond of grace", {}, "replace_successor"],
    ["after grace", { rotated_at: EpochMs.parse(90) }, "revoke_family"],
    ["successor also rotated", { live_parent: Uint8Array.of(2) }, "revoke_family"],
    ["no live successor", { has_live: false }, "revoke_family"],
    ["already revoked", { revoked_at: now }, "invalid_grant"],
    ["expired just now", { expires_at: now }, "invalid_grant"],
    ["another key", { jkt: "foreign" }, "invalid_grant"],
] as const)(
    "a refresh with %s selects the correct family operation",
    (_label, fields, expected) => {
        const result = decideRefresh({
            held: { ...successor, ...fields },
            jkt: "key",
            txNow: now,
            tokenHash: parent,
            graceMs: 10,
        });
        expect(result.ok ? result.value : result.error.code).toBe(expected);
    },
);
