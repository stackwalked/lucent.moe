import { SHARED_COPY } from "../../copy/shared.ts";

export const APPEAL_TITLE = "appeal";

export const APPEAL_COPY = {
    suspended: SHARED_COPY.suspended,
    reason: "reason given",
    noReason: SHARED_COPY.noneRecorded,
    since: "suspended",
    thread: "your appeal",
    none: "no messages",
    first: "why lift the suspension?",
    more: "write to staff",
    send: "send",
    signOut: "sign out",
    states: {
        open: "waiting for staff",
        answered: "staff answered",
        closed: "closed",
    },
    window: "this session lasts 30 minutes. sign in again to come back.",
} as const;
