import { expect, test } from "bun:test";
import { AccountId, EpochMs } from "@lucent/core/scalars";
import {
    decideDeviceChange,
    decideDeviceRemoval,
    decideEnrollmentApproval,
    decideEnrollmentRequest,
    decidePendingEnrollment,
    decidePendingRequest,
} from "../src/identity/devices/devices.rules.ts";

const accountId = AccountId.parse(`acc_${"a".repeat(22)}`);
const other = AccountId.parse(`acc_${"b".repeat(22)}`);
test.each([
    [accountId, 1, "ALREADY_ENROLLED", "FORBIDDEN"],
    [other, 1, "KEY_IN_USE", "FORBIDDEN"],
    [null, 1, "check_window", "check_window"],
    [null, 0, "enroll", "enroll"],
] as const)(
    "key ownership is checked before capacity for %s with %i live devices",
    (owner, liveCount, request, approval) => {
        const snapshot = { accountId, owner, liveCount, limit: 1 };
        const r = decideEnrollmentRequest(snapshot);
        const a = decideEnrollmentApproval(snapshot);
        expect(r.ok ? r.value : r.error.code).toBe(request);
        expect(a.ok ? a.value : a.error.code).toBe(approval);
    },
);
test.each([
    [null, true],
    [89, true],
    [90, true],
    [91, false],
] as const)(
    "a replacement last made at %s is allowed only after the whole window",
    (last, allowed) => {
        const result = decideDeviceChange({
            lastReplacedAt: last === null ? null : EpochMs.parse(last),
            txNow: EpochMs.parse(100),
            windowMs: 10,
            refusal: { code: "DEVICE_CHANGE_TOO_SOON" },
        });
        expect(result).toEqual(
            allowed
                ? { ok: true, value: undefined }
                : { ok: false, error: { code: "DEVICE_CHANGE_TOO_SOON" } },
        );
    },
);
test.each([
    [99, false],
    [100, false],
    [101, true],
] as const)(
    "pending enrollment expiring at %i can be reused only while approvable",
    (expiry, reusable) => {
        const now = EpochMs.parse(100);
        const row = { id: Uint8Array.of(4), expires_at: EpochMs.parse(expiry), state: "pending" };
        expect(decidePendingEnrollment(row, now).ok).toBe(reusable);
        expect(decidePendingRequest(row, now, 20)).toEqual({
            ok: true,
            value: reusable
                ? { kind: "reuse", row }
                : { kind: "insert", expire: row.id, expiresAt: EpochMs.parse(120) },
        });
    },
);
test.each([
    [1, true],
    [2, false],
] as const)("only a live device id can be removed: %i", (id, allowed) => {
    expect(decideDeviceRemoval([Uint8Array.of(1)], Uint8Array.of(id)).ok).toBe(allowed);
});
