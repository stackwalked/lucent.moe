export const INVITE_TREE_COPY = {
    title: "invite tree",
    none: "no invites used",
    truncated: "first 2000 accounts",
    invitees: (n: number) => (n === 1 ? "1 invitee" : `${n} invitees`),
    strikes: (ever: number, now: number) =>
        ever === 0
            ? "no strikes"
            : `${ever === 1 ? "1 strike" : `${ever} strikes`}, ${now} suspended now`,
    invites: "invites",
    invitedBy: "invited by",
    nobody: "staff or before invites",
    allowance: "allowance",
    allowanceOf: (spent: number, granted: number) => `${spent} of ${granted} used`,
    strikesLabel: "strikes (suspended invitees)",
    change: "change allowance",
    changeTitle: (name: string) => `invites for ${name}`,
    granted: "invites in all",
    wholeNumber: "a whole number from 0 to 1000.",
} as const;
