import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import {
    decideResetLink,
    decideResetRedeem,
    decideResetRequest,
    RESET_LINK_TTL_MS,
    type ResetAccount,
} from "../src/identity/auth/password-reset.rules.ts";

const now = EpochMs.parse(1_000_000);
const at = (offset: number) => EpochMs.parse(now + offset);
const member: ResetAccount = {
    email: "alice@lucent.test",
    status: "active",
    isLocked: false,
    isRoot: false,
    hasUsername: true,
    roleForever: false,
    roleLatestExpiry: null,
    hasSecondFactor: true,
};

test.each([
    ["no link", null, "LINK_INVALID"],
    ["expires in the future", { expiresAt: at(1) }, null],
    ["expires exactly now", { expiresAt: at(0) }, "LINK_INVALID"],
    ["expired", { expiresAt: at(-1) }, "LINK_INVALID"],
] as const)("a link is usable only strictly before its expiry: %s", (_, link, refusal) => {
    const decided = decideResetLink(link, now);
    expect(decided.ok ? null : decided.error.code).toBe(refusal);
});

const ineligible: readonly (readonly [string, Partial<ResetAccount>])[] = [
    ["suspended", { status: "suspended" }],
    ["locked", { isLocked: true }],
    ["root", { isRoot: true }],
    ["without a username", { hasUsername: false }],
    ["holding a permanent role", { roleForever: true }],
    ["holding a role that ends later", { roleLatestExpiry: at(1) }],
    ["without a second factor", { hasSecondFactor: false }],
];

test.each(ineligible)("a request for an account %s sends nothing", (_, change) => {
    expect(decideResetRequest({ account: { ...member, ...change }, link: null, now })).toEqual(
        err({ code: "INELIGIBLE" }),
    );
});

test("a role ending now or before no longer keeps an account out", () => {
    for (const roleLatestExpiry of [at(0), at(-1)])
        expect(
            decideResetRequest({ account: { ...member, roleLatestExpiry }, link: null, now }).ok,
        ).toBe(true);
});

test("a request for no account is refused as such, for the writer to answer alike", () => {
    expect(decideResetRequest({ account: null, link: null, now })).toEqual(
        err({ code: "NO_ACCOUNT" }),
    );
});

test("a request issues a link for fifteen minutes and replaces only an expired one", () => {
    expect(decideResetRequest({ account: member, link: null, now })).toEqual(
        ok({ email: member.email, replaceExpired: false, expiresAt: at(RESET_LINK_TTL_MS) }),
    );
    expect(decideResetRequest({ account: member, link: { expiresAt: at(0) }, now })).toEqual(
        ok({ email: member.email, replaceExpired: true, expiresAt: at(RESET_LINK_TTL_MS) }),
    );
    expect(decideResetRequest({ account: member, link: { expiresAt: at(1) }, now })).toEqual(
        err({ code: "LINK_LIVE" }),
    );
});

test.each([
    ["an eligible account with a live link", member, { expiresAt: at(1) }, true],
    ["a link that expires now", member, { expiresAt: at(0) }, false],
    ["no link", member, null, false],
    ["no account", null, { expiresAt: at(1) }, false],
    [
        "an account promoted since the request",
        { ...member, roleForever: true },
        { expiresAt: at(1) },
        false,
    ],
] as const)("redemption with %s", (_, account, link, redeemed) => {
    expect(decideResetRedeem({ account, link, now })).toEqual(
        redeemed ? ok(undefined) : err({ code: "RESET_INVALID" }),
    );
});
