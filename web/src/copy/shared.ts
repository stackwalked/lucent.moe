// Words more than one place says, kept as one string so they read and stop the same everywhere.
// A full stop ends a sentence (a verb, or an instruction); labels, statuses and empty states
// have none.
export const SHARED_COPY = {
    notFound: "not found",
    suspended: "account suspended",
    noneRecorded: "none recorded",
    setupLinkGone: "setup link expired or used. ask staff for a new one.",
    needsPasskey: "needs a passkey. add one in security.",
    wrongCode: "wrong code",
} as const;
