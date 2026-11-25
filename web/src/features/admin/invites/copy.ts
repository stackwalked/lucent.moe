export const INVITE_TREE_COPY = {
    title: "invite tree",
    intro: "who invited whom. a strike is an invitee who was suspended; it counts against whoever invited them.",
    none: "nobody has used an invite yet.",
    truncated: "showing the first 2000 accounts.",
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
    strikesLabel: "strikes",
    change: "change allowance",
    changeTitle: (name: string) => `invites for ${name}`,
    changeBody: "how many invites this account may issue in all. it can't go below what's used.",
    granted: "invites in all",
    wholeNumber: "a whole number from 0 to 1000.",
} as const;
