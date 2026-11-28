import { err, ok } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";

// The waitlist. An application waits (`pending`) until staff approve it, which creates the account
// and mails its setup link, or decline it. Both are final: an approval made an account, and a
// declined applicant may apply again once REAPPLY_AFTER_MS has passed, as a new application. No
// state for "on hold" or "reopened": staff leave an application pending, and a decline made in
// error is undone by the applicant applying again or by staff creating the account by hand.
export type ApplicationState = "none" | "pending" | "approved" | "declined";

// `submit` is the public form, against the address's latest application ("none" if it has none);
// `approve` and `decline` are staff's, against the application they name ("none" if it doesn't
// exist).
export type ApplicationEvent = "submit" | "approve" | "decline";

export const APPLICATION_STATES = ["none", "pending", "approved", "declined"] as const;
export const APPLICATION_EVENTS = ["submit", "approve", "decline"] as const;

export const REAPPLY_AFTER_MS = 30 * 24 * 60 * 60_000;

// How long the Discord user an applicant verified is held for the form: long enough to fill it in
// without the link being redone, short enough that a forgotten tab holds nothing for long.
export const DISCORD_CLAIM_TTL_MS = 60 * 60_000;

// What the decision reads besides the state: whether the address has an account, and when the
// application in `state` was decided.
export type ApplicationFacts = {
    readonly emailHasAccount: boolean;
    readonly decidedAt: EpochMs | null;
    readonly now: EpochMs;
};

// `open`: a new pending application. `ignore`: a submission that changes nothing; the applicant
// hears the same as for `open`, so the form never says whether an address has an account or an
// application.
export type ApplicationPlan = "open" | "ignore" | "approve" | "decline";

export function decideApplication(params: {
    readonly state: ApplicationState;
    readonly event: ApplicationEvent;
    readonly facts: ApplicationFacts;
}) {
    const { state, event, facts } = params;
    if (event === "submit") {
        // Left for the human: an account whose setup link lapsed unused has no way in, and its
        // address applying again is ignored here all the same.
        if (facts.emailHasAccount) return ok<ApplicationPlan>("ignore");
        if (state === "pending" || state === "approved") return ok<ApplicationPlan>("ignore");
        if (
            state === "declined" &&
            (facts.decidedAt === null || facts.now - facts.decidedAt < REAPPLY_AFTER_MS)
        )
            return ok<ApplicationPlan>("ignore");
        return ok<ApplicationPlan>("open");
    }
    if (state === "none") return err({ code: "NOT_FOUND" } as const);
    if (state !== "pending") return err({ code: "ALREADY_DECIDED" } as const);
    if (event === "decline") return ok<ApplicationPlan>("decline");
    // The address got an account meanwhile (an invite, or staff): approving would make a second.
    if (facts.emailHasAccount) return err({ code: "EMAIL_TAKEN" } as const);
    return ok<ApplicationPlan>("approve");
}
