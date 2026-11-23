import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import { LEASE_DURATION_MS, RESUME_WINDOW_MS, SESSION_CAP_MS } from "../src/runtime/leases.ts";
import {
    decideCloseSession,
    decideLiveSession,
    decideOpenDevice,
    decideOpenSession,
    decideRenewalFrame,
    decideRenewLease,
    decideReplaySequence,
    decideSessionAccess,
    decideSessionStanding,
} from "../src/runtime/sessions.rules.ts";

test.each([
    [100, "other", "DEVICE_REVOKED"],
    [100, "jkt", "DEVICE_REVOKED"],
    [null, "other", "START_MISMATCH"],
    [null, "jkt", null],
] as const)(
    "a revoked PC is refused before a start made on another: revoked %s, key %s",
    (revokedAt, jkt, expected) => {
        const r = decideOpenDevice(
            { revokedAt: revokedAt === null ? null : EpochMs.parse(revokedAt), jkt: "jkt" },
            jkt,
        );
        expect(r.ok ? null : r.error.code).toBe(expected);
    },
);
test.each([
    [false, "beta", "ENTITLEMENT_INACTIVE"],
    [false, "stable", "ENTITLEMENT_INACTIVE"],
    [true, "beta", "CHANNEL_NOT_ALLOWED"],
    [true, "stable", null],
] as const)(
    "a session opens only on a channel the account still holds: entitled %s, %s",
    (isEntitled, channel, expected) => {
        const r = decideSessionAccess({ isEntitled, channels: ["stable"] }, channel);
        expect(r.ok ? null : r.error.code).toBe(expected);
    },
);

const now = EpochMs.parse(SESSION_CAP_MS + RESUME_WINDOW_MS);
test.each([
    [false, true, 2n, 0, 0, "suspended", "ACCOUNT_SUSPENDED"],
    [true, true, 2n, 0, 0, "device_revoked", "DEVICE_REVOKED"],
    [true, false, 2n, 0, 0, "slot_taken", "SLOT_TAKEN"],
    [true, false, 1n, now - RESUME_WINDOW_MS, 0, "expired", "SESSION_ENDED"],
    [true, false, 1n, now, now - SESSION_CAP_MS, "capped", "SESSION_ENDED"],
    [true, false, 1n, now - RESUME_WINDOW_MS + 1, now - SESSION_CAP_MS + 1, null, null],
] as const)(
    "session ends first for %s/%s generation %s, expiry %s, created %s",
    (accountActive, deviceRevoked, generation, expires, created, reason, code) => {
        const r = decideSessionStanding({
            accountActive,
            deviceRevoked,
            slot: { generation },
            session: {
                slot_generation: 1n,
                lease_expires_at: EpochMs.parse(expires),
                created_at: EpochMs.parse(created),
            },
            txNow: now,
        });
        expect(r.ok ? null : r.error.reason).toBe(reason);
        expect(r.ok ? null : r.error.refusal.code).toBe(code);
        const replay = decideLiveSession(reason);
        expect(replay.ok ? null : replay.error.code).toBe(code);
        expect(decideCloseSession(reason)).toEqual({
            ok: true,
            value: reason === null ? "close" : "already_ended",
        });
    },
);
test.each([
    [false, 2, "START_EXPIRED"],
    [true, 2, "START_MISMATCH"],
    [true, 1, null],
] as const)(
    "opening an unused %s start with release %i takes only the next slot generation",
    (unused, release, refusal) => {
        const plan = decideOpenSession({
            unused,
            expiresAt: EpochMs.parse(now + 1),
            txNow: now,
            helloRelease: Uint8Array.of(release),
            startRelease: Uint8Array.of(1),
            generation: 8n,
        });
        expect(plan.ok ? plan.value : plan.error.code).toEqual(
            refusal ?? { generation: 9n, deadline: EpochMs.parse(now + LEASE_DURATION_MS) },
        );
    },
);
test.each([
    [3n, false, true, false],
    [4n, true, false, true],
    [5n, true, false, false],
] as const)(
    "frame and lease counters have distinct freshness rules at sequence %s",
    (received, fresh, replay, renew) => {
        expect(decideRenewalFrame(received, 3n).ok).toBe(fresh);
        expect(decideReplaySequence(3n, received).ok).toBe(replay);
        const r = decideRenewLease(3n, received, now);
        expect(r).toEqual(
            renew
                ? {
                      ok: true,
                      value: { sequence: 4n, deadline: EpochMs.parse(now + LEASE_DURATION_MS) },
                  }
                : { ok: false, error: { code: "STALE_SEQUENCE" } },
        );
    },
);
