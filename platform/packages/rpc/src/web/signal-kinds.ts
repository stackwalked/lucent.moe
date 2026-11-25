// The risk signal kinds platform records and staff read on the review queue (admin.review.list
// names them in each item's contributions). Here, without zod, so web's copy can be checked
// against the list in browser code; platform's risk/signals.rules.ts takes its kinds from it.
export const SIGNAL_KINDS = [
    "loader_silent",
    "software_device_key",
    "new_country",
    // The renewal's integrity bits, one kind each (platform/packages/wire/src/renewal-bits.ts).
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
