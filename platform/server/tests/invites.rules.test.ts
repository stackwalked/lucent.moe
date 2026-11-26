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
    MAX_PROBES,
    spentOf,
} from "../src/identity/admission/invites.rules.ts";

const now = EpochMs.parse(10_000_000_000);
const at = (offset: number) => EpochMs.parse(now + offset);

const unused: Invite = { expiresAt: at(1), revokedAt: null, redeemedAt: null, probes: 0 };
const used: Invite = { expiresAt: at(-5), revokedAt: null, redeemedAt: at(-10), probes: 0 };
const revoked: Invite = { expiresAt: at(1), revokedAt: at(-1), redeemedAt: null, probes: 0 };
const expired: Invite = { expiresAt: at(0), revokedAt: null, redeemedAt: null, probes: 0 };
const probedOut: Invite = { ...unused, probes: MAX_PROBES };

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
    ["used once probed out, so its inviter learns nothing from it", probedOut, "used"],
    ["used once probed out, even past its expiry", { ...probedOut, expiresAt: at(-1) }, "used"],
    ["unused with probes left", { ...unused, probes: MAX_PROBES - 1 }, "unused"],
] as const)("an invite is %s", (_, invite, state) => {
    expect(inviteStateAt(invite, now)).toBe(state);
});

test("an invite used, probed out or still open is spent; one revoked or left to expire is not", () => {
    expect(
        spentOf([unused, used, revoked, expired, { ...probedOut, expiresAt: at(-1) }], now),
    ).toBe(3);
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
    ["unknown", null, true, false, "UNKNOWN"],
    ["used", used, true, false, "USED"],
    ["revoked", revoked, true, false, "REVOKED"],
    ["expired", expired, true, false, "EXPIRED"],
    ["probed out, for a new address", probedOut, true, false, "USED"],
    ["probed out, for a taken address", probedOut, true, true, "USED"],
    ["unused but its inviter is suspended or locked", unused, false, false, "INVITER_UNAVAILABLE"],
    [
        "unused but its inviter is suspended, for a taken address",
        unused,
        false,
        true,
        "INVITER_UNAVAILABLE",
    ],
] as const)(
    "redeeming an invite %s is refused",
    (_, invite, inviterActive, emailTaken, refusal) => {
        const decided = decideRedeemInvite({ invite, inviterActive, emailTaken, now });
        expect(decided.ok ? null : decided.error.code).toBe(refusal);
    },
);

test.each([
    ["for a new address creates the account", 0, false, { kind: "create" }],
    ["with probes behind it, for a new address, still creates it", 2, false, { kind: "create" }],
    [
        "for a taken address is the first probe",
        0,
        true,
        { kind: "probe", probes: 1, closes: false },
    ],
    [
        "for a taken address is the second probe",
        1,
        true,
        { kind: "probe", probes: 2, closes: false },
    ],
    [
        "for a taken address a third time closes it",
        2,
        true,
        { kind: "probe", probes: 3, closes: true },
    ],
] as const)("redeeming a usable invite %s", (_, probes, emailTaken, plan) => {
    expect<unknown>(
        decideRedeemInvite({ invite: { ...unused, probes }, inviterActive: true, emailTaken, now }),
    ).toEqual({ ok: true, value: plan });
});

test.each([
    ["unused is revoked", unused, { ok: true, value: { revoke: true } }],
    ["used is refused", used, { ok: false, error: { code: "INVITE_USED" } }],
    ["probed out is refused as used", probedOut, { ok: false, error: { code: "INVITE_USED" } }],
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
