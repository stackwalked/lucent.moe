import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import {
    decideReviewItem,
    decideRiskScore,
    decideScoringFrom,
    type ObservedSignal,
    REVIEW_THRESHOLD,
} from "../src/risk/score.rules.ts";
import { decideOpenSignals, decideRenewalSignals } from "../src/risk/signals.rules.ts";

const DAY = 24 * 60 * 60 * 1_000;
const now = EpochMs.parse(100 * DAY);

function silent(session: string | null, ago = 0): ObservedSignal {
    return { kind: "loader_silent", sessionId: session, observedAt: EpochMs.parse(now - ago) };
}

function softwareKey(session: string): ObservedSignal {
    return { kind: "software_device_key", sessionId: session, observedAt: now };
}

test.each([
    ["nothing", [], 0, 0],
    ["a software key alone, a mark only", [softwareKey("a")], 0, 0],
    ["one silent session", [silent("a")], 25, 25],
    ["one session silent many times", [silent("a"), silent("a"), silent("a")], 25, 25],
    ["two silent sessions", [silent("a"), silent("b")], 44, 50],
    ["a silent session on a software key", [softwareKey("a"), silent("a")], 40, 25],
    ["two silent sessions days ago", [silent("a", 3 * DAY), silent("b", 2 * DAY)], 44, 0],
    [
        "six silent sessions, counted up to four",
        ["a", "b", "c", "d", "e", "f"].map((s) => silent(s)),
        68,
        100,
    ],
    ["silences outside a session, each its own", [silent(null), silent(null)], 44, 50],
] as const)("%s scores risk %i and urgency %i", (_, signals, risk, urgency) => {
    const score = decideRiskScore(signals, now);
    expect(score.ok && { risk: score.value.risk, urgency: score.value.urgency }).toEqual({
        risk,
        urgency,
    });
});

test("contributions name each kind once, with its sessions and last sighting", () => {
    const score = decideRiskScore([silent("a", DAY), softwareKey("a"), silent("b", 2 * DAY)], now);
    expect(score.ok && score.value.signals).toEqual([
        { kind: "loader_silent", sessions: 2, lastAt: EpochMs.parse(now - DAY), weight: 0.25 },
        { kind: "software_device_key", sessions: 1, lastAt: now, weight: 0 },
    ]);
});

const signals = [{ kind: "loader_silent" as const, sessions: 2, lastAt: now, weight: 0.25 }];

test.each([
    ["no item and a score below the threshold", null, REVIEW_THRESHOLD - 1, 50, "none", null],
    ["no item and a score at the threshold", null, REVIEW_THRESHOLD, 50, "open", [30, 50]],
    ["an open item and a lower score", [60, 80], 40, 10, "raise", [60, 80]],
    ["an open item and a higher risk", [60, 80], 70, 10, "raise", [70, 80]],
    ["an open item and the same score and signals", [44, 50], 44, 50, "none", null],
] as const)("%s: %s", (_, open, risk, urgency, kind, expected) => {
    const plan = decideReviewItem({
        open:
            open === null
                ? null
                : {
                      id: "1",
                      risk: open[0],
                      urgency: open[1],
                      signals: open[0] === 44 ? signals : [],
                  },
        score: { risk, urgency, signals },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.kind).toBe(kind);
    if (plan.value.kind === "none") return;
    expect([plan.value.score.risk, plan.value.score.urgency]).toEqual([...(expected ?? [])]);
});

test("each scoring run reads back five minutes behind the last one, the first everything", () => {
    expect(decideScoringFrom(null)).toEqual({ ok: true, value: null });
    expect(decideScoringFrom(now)).toEqual({ ok: true, value: EpochMs.parse(now - 300_000) });
});

test.each([
    [1n, false, []],
    [2n, false, ["loader_silent"]],
    [2n, true, []],
    [9n, false, ["loader_silent"]],
] as const)("renewing lease %s with a loader answer %s signals %j", (held, answered, kinds) => {
    expect(decideRenewalSignals({ heldSequence: held, loaderAnswered: answered })).toEqual({
        ok: true,
        value: [...kinds],
    });
});

test("a session on a software-backed key is marked, one on a TPM key is not", () => {
    expect(decideOpenSignals({ storage: "software" })).toEqual({
        ok: true,
        value: ["software_device_key"],
    });
    expect(decideOpenSignals({ storage: "tpm" })).toEqual({ ok: true, value: [] });
});
