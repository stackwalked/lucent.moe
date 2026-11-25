import type { SignalKind } from "@lucent/rpc/web/signal-kinds";

// Every signal kind the server records: one added there doesn't compile here until it has a
// label. A kind it no longer records shows its stored name.
const LABELS: Readonly<Record<SignalKind, string>> = {
    loader_silent: "loader stopped answering",
    software_device_key: "software device key",
    new_country: "sign-in from a new country",
    debugger_attached: "debugger attached",
    hardware_breakpoints: "hardware breakpoints",
    kernel_debugging: "kernel debugging on",
    test_signing: "test signing on",
    signature_enforcement_off: "driver signature enforcement off",
    code_writable: "our code made writable",
    virtual_machine: "virtual machine",
    unsigned_module: "unsigned module in the game",
    module_trap: "breakpoint hit in our module",
};

const KINDS: Readonly<Record<string, string>> = LABELS;

export const REVIEW_COPY = {
    title: "review",
    open: "open",
    decided: "closed",
    account: "account",
    risk: "risk",
    urgency: "urgency",
    signals: "signals",
    opened: "opened",
    closed: "closed",
    outcome: "outcome",
    by: "by",
    note: "note (optional)",
    nothingOpen: "nothing to review",
    truncatedOpen: "100 most urgent",
    truncatedDecided: "latest 100",
    nothingDecided: "nothing closed",
    dismiss: "dismiss",
    actioned: "mark acted on",
    dismissTitle: (account: string) => `dismiss the item for ${account}`,
    actionedTitle: (account: string) => `mark the item for ${account} acted on`,
    dismissBody: "closes it with no action.",
    actionedBody: "records that you acted. it changes nothing on the account.",
    outcomes: { no_action: "dismissed", actioned: "acted on" },
    kinds: KINDS,
    seen: (sessions: number) => (sessions === 1 ? "1 session" : `${sessions} sessions`),
    mark: "mark",
} as const;
