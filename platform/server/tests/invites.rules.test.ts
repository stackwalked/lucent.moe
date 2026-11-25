import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import {
    decideCreateInvite,
    decideRedeemInvite,
    decideRevokeInvite,
    decideSetAllowance,
    INVITE_TTL_MS,
    type Invite,
    inviteStateAt,
    spentOf,
} from "../src/admission/invites.rules.ts";

const now = EpochMs.parse(10_000_000_000);
const at = (offset: number) => EpochMs.parse(now + offset);

const unused: Invite = { expiresAt: at(1), revokedAt: null, redeemedAt: null };
const used: Invite = { expiresAt: at(-5), revokedAt: null, redeemedAt: at(-10) };
const revoked: Invite = { expiresAt: at(1), revokedAt: at(-1), redeemedAt: null };
const expired: Invite = { expiresAt: at(0), revokedAt: null, redeemedAt: null };

test.each([
    ["unused before its expiry", unused, "unused"],
    ["expired at the instant of its expiry", expired, "expired"],
    ["used, whatever its expiry", used, "used"],
    ["revoked before its expiry", revoked, "revoked"],
    [
        "revoked and since past its expiry",
        { ...revoked, expiresAt: at(-1), revokedAt: at(-2) },
        "revoked",
    ],
] as const)("an invite is %s", (_, invite, state) => {
    expect(inviteStateAt(invite, now)).toBe(state);
});

test("an invite used or still open is spent; one revoked or left to expire is not", () => {
    expect(spentOf([unused, used, revoked, expired], now)).toBe(2);
});

test.each([
    ["no allowance", 0, 0, "NO_ALLOWANCE"],
    ["allowance all spent", 2, 2, "NO_ALLOWANCE"],
    ["more spent than granted after staff lowered it", 1, 2, "NO_ALLOWANCE"],
    ["allowance left", 2, 1, null],
] as const)("creating an invite with %s", (_, granted, spent, refusal) => {
    const decided = decideCreateInvite({ granted, spent, now });
    expect(decided.ok ? null : decided.error.code).toBe(refusal);
});

test("an invite lasts seven days from its creation", () => {
    expect(decideCreateInvite({ granted: 1, spent: 0, now })).toEqual({
        ok: true,
        value: { expiresAt: at(INVITE_TTL_MS) },
    });
});

test.each([
    ["unknown", null, true, "UNKNOWN"],
    ["used", used, true, "USED"],
    ["revoked", revoked, true, "REVOKED"],
    ["expired", expired, true, "EXPIRED"],
    ["unused but its inviter is suspended or locked", unused, false, "INVITER_UNAVAILABLE"],
    ["unused from an inviter in good standing", unused, true, null],
] as const)("redeeming an invite %s", (_, invite, inviterActive, refusal) => {
    const decided = decideRedeemInvite({ invite, inviterActive, now });
    expect(decided.ok ? null : decided.error.code).toBe(refusal);
});

test.each([
    ["unused is revoked", unused, { ok: true, value: { revoke: true } }],
    ["used is refused", used, { ok: false, error: { code: "INVITE_USED" } }],
    ["already revoked changes nothing", revoked, { ok: true, value: { revoke: false } }],
    ["expired changes nothing", expired, { ok: true, value: { revoke: false } }],
] as const)("revoking an invite that is %s", (_, invite, outcome) => {
    expect(decideRevokeInvite(invite, now)).toEqual(outcome);
});

test.each([
    ["to what is spent", 2, 2, null],
    ["above what is spent", 5, 2, null],
    ["to zero with nothing spent", 0, 0, null],
    ["below what is spent", 1, 2, "BELOW_SPENT"],
    ["below zero", -1, 0, "INVALID_ALLOWANCE"],
    ["past the bound", 1_001, 0, "INVALID_ALLOWANCE"],
    ["to a fraction", 1.5, 0, "INVALID_ALLOWANCE"],
] as const)("setting an allowance %s", (_, granted, spent, refusal) => {
    const decided = decideSetAllowance({ granted, spent });
    expect(decided.ok ? null : decided.error.code).toBe(refusal);
});
