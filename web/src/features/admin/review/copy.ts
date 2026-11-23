// A signal kind the server knows; one it no longer does shows its stored name.
const KINDS: Readonly<Record<string, string>> = {
    loader_silent: "loader stopped answering",
    software_device_key: "software device key",
};

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
    note: "note",
    noteHint: "optional. staff only.",
    nothingOpen: "nothing to review.",
    truncatedOpen: "showing the 100 most urgent. close some to see the rest.",
    truncatedDecided: "showing the 100 latest.",
    nothingDecided: "nothing closed yet.",
    dismiss: "dismiss",
    actioned: "mark acted on",
    dismissTitle: (account: string) => `dismiss the item for ${account}`,
    actionedTitle: (account: string) => `mark the item for ${account} acted on`,
    dismissBody: "closes it with no action. new signals open a new item.",
    actionedBody:
        "records that you acted. suspend or take other steps on the account page; this changes nothing there.",
    outcomes: { no_action: "dismissed", actioned: "acted on" },
    kinds: KINDS,
    seen: (sessions: number) => (sessions === 1 ? "1 session" : `${sessions} sessions`),
    mark: "mark",
} as const;
