import { ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import type { SignalKind } from "./signals.rules.ts";

// An account's risk, from its signals since its last decided review item. Risk is how likely a
// violation is, urgency how fast the harm grows; both run 0 to 100. People act on the queue this
// fills; nothing here bans, revokes or delays anything (wishlist/protection.md, "Signals").
//
// Each kind weighs once per session it was seen in, up to SESSION_CAP sessions (COUNTED_CAP for
// some kinds), so one long session can't outweigh a pattern across many. Combinations carry
// weight of their own: a kind that is only a mark (weight 0) counts when it appears beside
// another.
//
// The human's standing rule: nothing common among honest members opens a review item alone, at
// any count. Members use VPNs and travel; some run VMs, load unsigned mods or overlays, or keep
// test signing or kernel debugging on for other software. Those kinds weigh little and count a
// capped number of times, so each alone stays under REVIEW_THRESHOLD, and they still add to
// anything else (score.rules.test.ts holds this).

const WEIGHTS: Readonly<Record<SignalKind, number>> = {
    loader_silent: 0.25,
    software_device_key: 0,
    // Members travel and use VPNs, so a new country alone stays under the review threshold; it
    // still adds to any other signal.
    new_country: 0.15,
    // A debugger on the game, the host or our loader: no honest play needs one attached to our
    // own processes. It opens an item alone, at one session; the item asks staff to look and
    // changes nothing for the member.
    debugger_attached: 0.35,
    // Debug registers set on the game's threads: what a debugger leaves, or a tracer that wants
    // to look like none. Rarely honest (a few overlays set them), so a pattern of three sessions.
    hardware_breakpoints: 0.15,
    // Our code made writable: someone patching it, unless the bit also covers pages an overlay
    // hooks in the game, in which case this should drop to a mark. Three sessions, as above.
    code_writable: 0.15,
    // A breakpoint, single step or guard page hit raised inside our own image (signals.rules.ts).
    // Three sessions: one could be a bug of ours sending control into padding, which staff would
    // also see on the crashes page for every member of the release.
    module_trap: 0.15,
    // Properties of the machine, not of play: they repeat every session on the same PC, so a
    // second sighting says nothing new and each counts once (COUNTED_CAP). Kernel debugging and
    // signature enforcement off are how unsigned kernel drivers load, cheats among them, so they
    // weigh a little more than a VM, test signing or an unsigned module in the game.
    kernel_debugging: 0.15,
    signature_enforcement_off: 0.15,
    test_signing: 0.1,
    virtual_machine: 0.1,
    unsigned_module: 0.1,
};

const COMBINATIONS: readonly { readonly kinds: readonly SignalKind[]; readonly weight: number }[] =
    [{ kinds: ["software_device_key", "loader_silent"], weight: 0.2 }];

const SESSION_CAP = 4;

// A kind counted fewer times than that. Every new country is an occurrence of its own, and a
// member hopping VPN exits collects several: counted once, any number of them alone stays where
// one does, under the review threshold. Machine properties repeat every session on the same PC,
// so a second sighting says nothing new: counted once too.
const COUNTED_CAP: Readonly<Partial<Record<SignalKind, number>>> = {
    new_country: 1,
    kernel_debugging: 1,
    signature_enforcement_off: 1,
    test_signing: 1,
    virtual_machine: 1,
    unsigned_module: 1,
};

// Urgency counts the weighted sessions of the last day, each a quarter of the scale.
const URGENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const URGENCY_PER_SESSION = 25;

// An account with no open item gets one at this risk.
export const REVIEW_THRESHOLD = 30;

export type ObservedSignal = {
    readonly kind: SignalKind;
    // Hex, or null for what the server observed outside a session.
    readonly sessionId: string | null;
    readonly observedAt: EpochMs;
};

// What staff see of why an item scored as it did.
export type Contribution = {
    readonly kind: SignalKind;
    readonly sessions: number;
    readonly lastAt: EpochMs;
    readonly weight: number;
};

export type RiskScore = {
    readonly risk: number;
    readonly urgency: number;
    // Sorted by kind.
    readonly signals: readonly Contribution[];
};

export function decideRiskScore(
    signals: readonly ObservedSignal[],
    txNow: EpochMs,
): Result<RiskScore, never> {
    const sessionsOf = new Map<SignalKind, Set<string>>();
    const recentWeighted = new Set<string>();
    const lastAt = new Map<SignalKind, EpochMs>();
    signals.forEach((signal, index) => {
        const occurrence = signal.sessionId ?? `signal:${index}`;
        const seen = sessionsOf.get(signal.kind) ?? new Set<string>();
        seen.add(occurrence);
        sessionsOf.set(signal.kind, seen);
        const last = lastAt.get(signal.kind);
        if (last === undefined || signal.observedAt > last)
            lastAt.set(signal.kind, signal.observedAt);
        if (WEIGHTS[signal.kind] > 0 && txNow - signal.observedAt < URGENT_WINDOW_MS) {
            recentWeighted.add(occurrence);
        }
    });

    let clean = 1;
    const contributions: Contribution[] = [];
    for (const [kind, sessions] of [...sessionsOf].sort(([a], [b]) => a.localeCompare(b))) {
        const counted = Math.min(sessions.size, COUNTED_CAP[kind] ?? SESSION_CAP);
        clean *= (1 - WEIGHTS[kind]) ** counted;
        contributions.push({
            kind,
            sessions: sessions.size,
            lastAt: lastAt.get(kind) ?? txNow,
            weight: WEIGHTS[kind],
        });
    }
    for (const combination of COMBINATIONS) {
        if (combination.kinds.every((kind) => sessionsOf.has(kind)))
            clean *= 1 - combination.weight;
    }
    const risk = Math.round(100 * (1 - clean));
    const urgency = risk === 0 ? 0 : Math.min(100, URGENCY_PER_SESSION * recentWeighted.size);
    return ok({ risk, urgency, signals: contributions });
}

// A signal carries its writer's transaction time but becomes visible only at its commit, so each
// run reads back this far behind where the last one stopped; rescoring an account is idempotent.
const COMMIT_SLACK_MS = 5 * 60 * 1_000;

// The earliest observation a run reads; null reads everything (the first run).
export function decideScoringFrom(through: EpochMs | null): Result<EpochMs | null, never> {
    return ok(through === null ? null : EpochMs.parse(Math.max(0, through - COMMIT_SLACK_MS)));
}

export type OpenItem = {
    readonly id: string;
    readonly risk: number;
    readonly urgency: number;
    readonly signals: readonly Contribution[];
};

export type ReviewPlan =
    | { readonly kind: "none" }
    | { readonly kind: "open"; readonly score: RiskScore }
    | { readonly kind: "raise"; readonly id: string; readonly score: RiskScore };

function sameContributions(left: readonly Contribution[], right: readonly Contribution[]): boolean {
    return (
        left.length === right.length &&
        left.every((one, index) => {
            const other = right[index];
            return (
                other !== undefined &&
                one.kind === other.kind &&
                one.sessions === other.sessions &&
                one.lastAt === other.lastAt &&
                one.weight === other.weight
            );
        })
    );
}

// Client signals only raise suspicion: an open item keeps the higher of its scores and the new
// ones, with the new contributions, and is left alone when nothing differs. Without one, an item
// opens at the threshold.
export function decideReviewItem(params: {
    readonly open: OpenItem | null;
    readonly score: RiskScore;
}): Result<ReviewPlan, never> {
    const { open, score } = params;
    if (open === null) {
        return ok(score.risk >= REVIEW_THRESHOLD ? { kind: "open", score } : { kind: "none" });
    }
    const raised = {
        risk: Math.max(open.risk, score.risk),
        urgency: Math.max(open.urgency, score.urgency),
        signals: score.signals,
    };
    const unchanged =
        raised.risk === open.risk &&
        raised.urgency === open.urgency &&
        sameContributions(open.signals, score.signals);
    return ok(unchanged ? { kind: "none" } : { kind: "raise", id: open.id, score: raised });
}
