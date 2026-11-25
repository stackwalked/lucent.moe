import { expect, test } from "bun:test";
import { EpochMs } from "@lucent/core/scalars";
import {
    decideReviewItem,
    decideRiskScore,
    decideScoringFrom,
    type ObservedSignal,
    REVIEW_THRESHOLD,
} from "../src/risk/score.rules.ts";
import {
    decideIntegritySignals,
    decideOpenSignals,
    decideRenewalSignals,
    decideReportSignals,
    type SignalKind,
} from "../src/risk/signals.rules.ts";

const DAY = 24 * 60 * 60 * 1_000;
const now = EpochMs.parse(100 * DAY);

function silent(session: string | null, ago = 0): ObservedSignal {
    return { kind: "loader_silent", sessionId: session, observedAt: EpochMs.parse(now - ago) };
}

function softwareKey(session: string): ObservedSignal {
    return { kind: "software_device_key", sessionId: session, observedAt: now };
}

function newCountry(session: string | null): ObservedSignal {
    return { kind: "new_country", sessionId: session, observedAt: now };
}

test.each([
    ["nothing", [], 0, 0],
    ["a software key alone, a mark only", [softwareKey("a")], 0, 0],
    ["a new country alone, under the threshold", [newCountry(null)], 15, 25],
    [
        "new countries alone, however many, where one is",
        [newCountry(null), newCountry(null), newCountry(null), newCountry(null)],
        15,
        100,
    ],
    ["a new country beside a silent session, over it", [newCountry(null), silent("a")], 36, 50],
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

function seen(kind: SignalKind, session: string | null): ObservedSignal {
    return { kind, sessionId: session, observedAt: now };
}

function riskOf(signals: readonly ObservedSignal[]): number {
    const score = decideRiskScore(signals, now);
    return score.ok ? score.value.risk : Number.NaN;
}

// Common among honest members (VPNs, VMs, mods and overlays, test signing or kernel debugging on
// for other software, a software-held key): none may open a review item by itself.
const HONEST_LOOKING: readonly SignalKind[] = [
    "software_device_key",
    "new_country",
    "virtual_machine",
    "test_signing",
    "unsigned_module",
    "kernel_debugging",
    "signature_enforcement_off",
    "hardware_breakpoints",
];

const ENVIRONMENT_KINDS = HONEST_LOOKING.filter((kind) => kind !== "software_device_key");

test.each(HONEST_LOOKING)("%s alone stays under the review threshold at any count", (kind) => {
    for (const count of [1, 2, 3, 4, 10, 100]) {
        const sessions = Array.from({ length: count }, (_, index) => seen(kind, `s${index}`));
        const outside = Array.from({ length: count }, () => seen(kind, null));

        expect({ count, risk: riskOf(sessions) < REVIEW_THRESHOLD }).toEqual({ count, risk: true });
        expect({ count, risk: riskOf(outside) < REVIEW_THRESHOLD }).toEqual({ count, risk: true });
    }
});

const everyEnvironmentKind = (sessions: number) =>
    Array.from({ length: sessions }, (_, index) =>
        ENVIRONMENT_KINDS.map((kind) => seen(kind, `s${index}`)),
    ).flat();

const many = (kind: SignalKind, count: number) =>
    Array.from({ length: count }, (_, index) => seen(kind, `s${index}`));

test.each([
    [
        "a driver developer's PC: kernel debugging, signature enforcement off, test signing",
        [
            seen("kernel_debugging", "a"),
            seen("signature_enforcement_off", "a"),
            seen("test_signing", "a"),
        ],
        25,
    ],
    [
        "a VM, test signing, an unsigned module and a new country",
        [
            seen("virtual_machine", "a"),
            seen("test_signing", "a"),
            seen("unsigned_module", "a"),
            seen("new_country", null),
        ],
        25,
    ],
    ["every environment kind in one session", everyEnvironmentKind(1), 25],
    ["every environment kind in 100 sessions", everyEnvironmentKind(100), 25],
    [
        "every environment kind beside one silent session",
        [...everyEnvironmentKind(1), silent("a")],
        44,
    ],
    ["a trap in our image in one session", many("module_trap", 1), 15],
    ["traps in our image in ten sessions, counted once", many("module_trap", 10), 15],
    ["a trap beside a debugger", [seen("module_trap", "a"), seen("debugger_attached", "a")], 45],
    ["a debugger attached in one session", [seen("debugger_attached", "a")], 35],
    ["a new country beside a VM", [seen("new_country", null), seen("virtual_machine", "a")], 24],
    ["hardware breakpoints in three sessions", many("hardware_breakpoints", 3), 25],
    ["writable code in three sessions", many("code_writable", 3), 39],
    ["a VM in four sessions counts once", many("virtual_machine", 4), 10],
] as const)("%s scores risk %i", (_, signals, risk) => {
    expect(riskOf(signals)).toBe(risk);
});

test("the environment group never opens an item alone and a silent loader beside it does", () => {
    expect(riskOf(everyEnvironmentKind(100))).toBeLessThan(REVIEW_THRESHOLD);
    expect(riskOf([...everyEnvironmentKind(100), silent("x")])).toBeGreaterThanOrEqual(
        REVIEW_THRESHOLD,
    );
});

test("contributions keep each environment kind's own weight", () => {
    const score = decideRiskScore([seen("virtual_machine", "a"), seen("test_signing", "a")], now);
    expect(score.ok && score.value.signals.map((signal) => [signal.kind, signal.weight])).toEqual([
        ["test_signing", 0.1],
        ["virtual_machine", 0.1],
    ]);
});
const CLEAN_FLAGS = {
    debugger: false,
    hardwareBreakpoints: false,
    kernelDebugging: false,
    testSigning: false,
    signatureEnforcementOff: false,
    codeWritable: false,
} as const;

const clean = {
    flags: CLEAN_FLAGS,
    vmVendor: null,
    windowsBuild: 0,
    moduleSlots: [0n, 0n, 0n, 0n],
} as const;

test.each([
    ["an all-zero field", clean, []],
    ["a Windows build alone", { ...clean, windowsBuild: 26_100 }, []],
    ["a debugger", { ...clean, flags: { ...CLEAN_FLAGS, debugger: true } }, ["debugger_attached"]],
    [
        "hardware breakpoints",
        { ...clean, flags: { ...CLEAN_FLAGS, hardwareBreakpoints: true } },
        ["hardware_breakpoints"],
    ],
    [
        "kernel debugging",
        { ...clean, flags: { ...CLEAN_FLAGS, kernelDebugging: true } },
        ["kernel_debugging"],
    ],
    ["test signing", { ...clean, flags: { ...CLEAN_FLAGS, testSigning: true } }, ["test_signing"]],
    [
        "signature enforcement off",
        { ...clean, flags: { ...CLEAN_FLAGS, signatureEnforcementOff: true } },
        ["signature_enforcement_off"],
    ],
    [
        "writable code pages",
        { ...clean, flags: { ...CLEAN_FLAGS, codeWritable: true } },
        ["code_writable"],
    ],
    ["a VMware guest", { ...clean, vmVendor: "vmware" }, ["virtual_machine"]],
    ["another hypervisor", { ...clean, vmVendor: "other_hypervisor" }, ["virtual_machine"]],
    [
        "one unsigned module in slot 3",
        { ...clean, moduleSlots: [0n, 0n, 5n, 0n] },
        ["unsigned_module"],
    ],
    ["four unsigned modules", { ...clean, moduleSlots: [4n, 2n, 3n, 4n] }, ["unsigned_module"]],
    [
        "everything",
        {
            flags: {
                debugger: true,
                hardwareBreakpoints: true,
                kernelDebugging: true,
                testSigning: true,
                signatureEnforcementOff: true,
                codeWritable: true,
            },
            vmVendor: "hyperv_guest",
            windowsBuild: 19_045,
            moduleSlots: [9n, 0n, 0n, 0n],
        },
        [
            "debugger_attached",
            "hardware_breakpoints",
            "kernel_debugging",
            "test_signing",
            "signature_enforcement_off",
            "code_writable",
            "virtual_machine",
            "unsigned_module",
        ],
    ],
] as const)("integrity bits with %s signal what the rules name", (_, bits, kinds) => {
    expect(decideIntegritySignals(bits, new Set())).toEqual({ ok: true, value: [...kinds] });
});

test("an integrity kind the session already has is not written again, a new one is", () => {
    const bits = {
        ...clean,
        flags: { ...CLEAN_FLAGS, debugger: true, testSigning: true },
        vmVendor: "vmware",
    } as const;
    expect(decideIntegritySignals(bits, new Set(["debugger_attached", "virtual_machine"]))).toEqual(
        {
            ok: true,
            value: ["test_signing"],
        },
    );
    expect(
        decideIntegritySignals(
            bits,
            new Set(["debugger_attached", "test_signing", "virtual_machine"]),
        ),
    ).toEqual({ ok: true, value: [] });
});

const crash = (exceptionCode: number, moduleHash = 0n) =>
    ({ kind: "crash", time: 1, exceptionCode, moduleHash, rva: 0x10, frames: [] }) as const;

test.each([
    ["nothing but health", [{ kind: "health", time: 1, eventId: 1, subject: 0n, value: 0 }], []],
    ["an access violation in our image", [crash(0xc000_0005)], []],
    ["a fail-fast in our image", [crash(0xc000_0409)], []],
    ["a breakpoint in another module", [crash(0x8000_0003, 0x77n)], []],
    ["a breakpoint in our image", [crash(0x8000_0003)], ["module_trap"]],
    ["a single step in our image", [crash(0x8000_0004)], ["module_trap"]],
    ["a guard page hit in our image", [crash(0x8000_0001)], ["module_trap"]],
    ["two traps in one batch, once", [crash(0x8000_0003), crash(0x8000_0004)], ["module_trap"]],
] as const)("a reports batch with %s signals what the rules name", (_, events, kinds) => {
    expect(decideReportSignals(events)).toEqual({ ok: true, value: [...kinds] });
});
