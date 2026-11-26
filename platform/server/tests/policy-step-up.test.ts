import { expect, test } from "bun:test";
import type { Seconds } from "@lucent/core/brands";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { EpochMs, newAccountId, newSessionId } from "@lucent/core/scalars";
import { ACTION_POLICY, ACTIONS, type StepUpTier } from "@lucent/policy/action-list";
import {
    authorize,
    RECENT_WINDOW_SECONDS,
    STEP_UP_WINDOW_SECONDS,
    type Subject,
} from "@lucent/policy/policy";
import { type BrowserSession, requireFresh } from "../src/identity/auth/sessions.ts";

// An explicit table, so a future edit to the action list fails loudly here.
const TIERS: Readonly<Record<(typeof ACTIONS)[number], StepUpTier>> = {
    "accounts:read": "none",
    "accounts:create": "recent",
    "accounts:suspend": "recent",
    "accounts:reinstate": "recent",
    "accounts:rename": "recent",
    "accounts:recover": "fresh",
    "roles:manage": "fresh",
    "roles:assign": "fresh",
    "devices:manage": "recent",
    "devices:override-window": "recent",
    "entitlements:issue": "recent",
    "entitlements:suspend": "recent",
    "entitlements:revoke": "recent",
    "releases:promote": "recent",
    "facts:promote": "recent",
    "facts:override": "recent",
    "tickets:reply": "none",
    "moderation:remove": "none",
    "applications:review": "none",
    "risk:review": "none",
    "audit:read": "none",
};

test.each(ACTIONS.map((action) => [action, TIERS[action]] as const))(
    "%s asks for %s",
    (action, tier) => {
        expect(ACTION_POLICY[action].stepUp).toBe(tier);
    },
);

const NOW = 2_000_000_000_000;
const RNG = createSeededRng(23);
const ACCOUNT = newAccountId(RNG);
const at = (secondsAgo: number) => EpochMs.parse(NOW - secondsAgo * 1_000);
const root = (when: { signedIn: number | null; stepUp: number | null }): Subject => ({
    accountId: ACCOUNT,
    isRoot: true,
    isActive: true,
    maxRank: 100,
    permissions: new Set(),
    stepUpAt: when.stepUp === null ? null : at(when.stepUp),
    authenticatedAt: when.signedIn === null ? null : at(when.signedIn),
});
const run = (
    action: (typeof ACTIONS)[number],
    when: { signedIn: number | null; stepUp: number | null },
) => authorize({ txNow: EpochMs.parse(NOW), subject: root(when), action });
const refused = (seconds: Seconds) =>
    err({ code: "STEP_UP_REQUIRED" as const, withinSeconds: seconds });
const passed = ok(undefined);

test.each([
    ["exactly 7 days since sign-in, no step-up", RECENT_WINDOW_SECONDS, null, passed],
    ["one second past 7 days", RECENT_WINDOW_SECONDS + 1, null, refused(RECENT_WINDOW_SECONDS)],
    [
        "old sign-in, step-up inside 7 days",
        RECENT_WINDOW_SECONDS * 2,
        RECENT_WINDOW_SECONDS - 5,
        passed,
    ],
    [
        "old sign-in, step-up outside 7 days",
        RECENT_WINDOW_SECONDS * 2,
        RECENT_WINDOW_SECONDS + 1,
        refused(RECENT_WINDOW_SECONDS),
    ],
    ["a sign-in an hour ago", 3_600, null, passed],
    ["no sign-in time and no step-up", null, null, refused(RECENT_WINDOW_SECONDS)],
] as const)("a recent action: %s", (_name, signedIn, stepUp, expected) => {
    expect(run("accounts:suspend", { signedIn, stepUp })).toEqual(expected);
});

test.each(["accounts:recover", "roles:manage"] as const)(
    "%s needs a step-up in the last 30 minutes",
    (action) => {
        expect(run(action, { signedIn: 10, stepUp: STEP_UP_WINDOW_SECONDS })).toEqual(passed);
        expect(run(action, { signedIn: 10, stepUp: STEP_UP_WINDOW_SECONDS + 60 })).toEqual(
            refused(STEP_UP_WINDOW_SECONDS),
        );
        expect(run(action, { signedIn: 10, stepUp: null })).toEqual(
            refused(STEP_UP_WINDOW_SECONDS),
        );
    },
);

test("an action that asks nothing asks nothing", () => {
    expect(run("tickets:reply", { signedIn: null, stepUp: null })).toEqual(passed);
    expect(run("audit:read", { signedIn: RECENT_WINDOW_SECONDS * 3, stepUp: null })).toEqual(
        passed,
    );
});

test("credential freshness still refuses just over five minutes after the last proof", () => {
    const session = (secondsAgo: number): BrowserSession => ({
        tokenHash: new Uint8Array(32),
        sessionId: newSessionId(RNG),
        accountId: ACCOUNT,
        purpose: "member",
        expiresAt: at(-3_600),
        authenticatedAt: at(secondsAgo),
        stepUpAt: null,
    });
    const txNow = EpochMs.parse(NOW);
    expect(requireFresh(session(300), txNow).ok).toBe(true);
    expect(requireFresh(session(301), txNow)).toEqual(
        err({ code: "REAUTH_REQUIRED", withinSeconds: 300 }),
    );
});
