import { ok, type Result } from "@lucent/core/result";
import type { RenewalBits } from "@lucent/wire/renewal-bits";
import type { ReportEvent } from "@lucent/wire/reports";

// What the server can tell from a session, as risk_signal kinds. A signal only ever raises
// suspicion and never changes what the client sees (wishlist/protection.md, "Signals"); the
// weights, and why each is what it is, live in score.rules.ts.
//
// Not here yet, because the server can't compute them: whether a challenge answer is right needs
// the server's own hash of the relocated image (native/libs/integrity's hash and its vectors in
// contracts/), and health events have no assigned ids to read. The Windows build the renewal
// carries is no signal: no build is suspect by itself. `new_country` comes from the sign-in
// country check (support/sign-in-countries.ts), outside any session.
export const SIGNAL_KINDS = [
    "loader_silent",
    "software_device_key",
    "new_country",
    // The renewal's integrity bits, one kind each (wire/renewal-bits.ts).
    "debugger_attached",
    "hardware_breakpoints",
    "kernel_debugging",
    "test_signing",
    "signature_enforcement_off",
    "code_writable",
    "virtual_machine",
    "unsigned_module",
    // A crash report from the reports route.
    "module_trap",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

// A device key held in software rather than a TPM is a mark staff see, weighed only in
// combination with something else.
export function decideOpenSignals(params: {
    readonly storage: "tpm" | "software";
}): Result<readonly SignalKind[], never> {
    return ok(params.storage === "software" ? ["software_device_key"] : []);
}

// The loader gets its first challenge with the first lease response, which answers the renewal
// of lease 1; from the renewal of lease 2 on, every renewal it relays carries its answer, and one
// without it is silence where a healthy loader speaks.
export function decideRenewalSignals(params: {
    readonly heldSequence: bigint;
    readonly loaderAnswered: boolean;
}): Result<readonly SignalKind[], never> {
    return ok(params.heldSequence >= 2n && !params.loaderAnswered ? ["loader_silent"] : []);
}

// What one renewal's integrity bits say, a kind per flag set, one for any VM vendor and one for
// any unsigned module. An all-zero field says nothing.
export function decideIntegritySignals(bits: RenewalBits): Result<readonly SignalKind[], never> {
    const { flags } = bits;
    const kinds: SignalKind[] = [];
    if (flags.debugger) kinds.push("debugger_attached");
    if (flags.hardwareBreakpoints) kinds.push("hardware_breakpoints");
    if (flags.kernelDebugging) kinds.push("kernel_debugging");
    if (flags.testSigning) kinds.push("test_signing");
    if (flags.signatureEnforcementOff) kinds.push("signature_enforcement_off");
    if (flags.codeWritable) kinds.push("code_writable");
    if (bits.vmVendor !== 0) kinds.push("virtual_machine");
    if (bits.unsignedModules.length > 0) kinds.push("unsigned_module");
    return ok(kinds);
}

// Exceptions a debugger or an inline tracer leaves behind (ntstatus.h): a breakpoint, a single
// step or a guard page hit. Our own code raises none of them: invariants fail fast
// (native/core/src/invariant.cpp, 0xC0000409), and native/ has no __debugbreak and sets no guard
// pages (searched 2026-11-25). One raised inside our image means someone put it there; an access
// violation or a fail-fast in it is our own bug and no signal. Wrong if native starts raising
// one of these itself: honest crashes would then signal.
const TRAP_CODES: ReadonlySet<number> = new Set([
    0x8000_0001, // STATUS_GUARD_PAGE_VIOLATION
    0x8000_0003, // STATUS_BREAKPOINT
    0x8000_0004, // STATUS_SINGLE_STEP
]);

// One kind per batch at most: a crash in the module's own image (module hash 0) on a trap.
export function decideReportSignals(
    events: readonly ReportEvent[],
): Result<readonly SignalKind[], never> {
    const trapped = events.some(
        (event) =>
            event.kind === "crash" &&
            event.moduleHash === 0n &&
            TRAP_CODES.has(event.exceptionCode),
    );
    return ok(trapped ? ["module_trap"] : []);
}
