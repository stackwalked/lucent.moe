export const APPEAL_TITLE = "appeal";

export const APPEAL_COPY = {
    suspended: "this account is suspended. you can appeal here.",
    reason: "reason given",
    noReason: "no reason was recorded.",
    since: "suspended",
    thread: "your appeal",
    none: "you haven't appealed yet.",
    first: "why should the suspension be lifted?",
    more: "write to staff",
    send: "send",
    signOut: "sign out",
    states: {
        open: "waiting for staff",
        answered: "staff answered",
        closed: "closed. writing again reopens it.",
    },
    window: "this session ends 30 minutes after you signed in. sign in again to come back.",
} as const;
