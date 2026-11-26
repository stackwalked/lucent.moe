import { SHARED_COPY } from "../../../copy/shared.ts";

export const STAFF_TICKETS_TITLE = "tickets";

export const STAFF_TICKETS_COPY = {
    views: { open: "waiting", answered: "answered", closed: "closed" },
    none: { open: "none waiting", answered: "none answered", closed: "none closed" },
    subject: "subject",
    appeal: "appeal",
    help: "help ticket",
    ownerDeleted: "account deleted",
    account: "account",
    product: "product",
    noProduct: "none",
    waiting: "waiting since",
    lastActivity: "last activity",
    state: "state",
    states: {
        open: "waiting for staff",
        answered: "waiting for the member",
        closed: "closed",
    },
    back: "all tickets",
    reply: "send",
    replyLabel: "answer",
    close: "close ticket",
    closeTitle: "close this ticket",
    closeBody: "the member can reopen it by writing.",
    suspended: SHARED_COPY.suspended,
    reason: "suspension reason",
    noReason: SHARED_COPY.noneRecorded,
    reinstate: "reinstate on the account page",
    configs: "config access",
    configsReadable: "the member allows it while this ticket is open",
    configsClosed: "the member doesn't allow it",
    member: "member",
} as const;
