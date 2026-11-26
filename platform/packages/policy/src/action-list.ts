// The actions without zod, for the browser; actions.ts adds the schema for code that parses with
// zod.

export const ACTIONS = [
    "accounts:read",
    "accounts:create",
    "accounts:suspend",
    "accounts:reinstate",
    "accounts:rename",
    "accounts:recover",
    "roles:manage",
    "roles:assign",
    "devices:manage",
    "devices:override-window",
    "entitlements:issue",
    "entitlements:suspend",
    "entitlements:revoke",
    "releases:promote",
    "facts:promote",
    "facts:override",
    "tickets:reply",
    "moderation:remove",
    "applications:review",
    "risk:review",
    "audit:read",
] as const;

export type Action = (typeof ACTIONS)[number];

export const isAction = (value: unknown): value is Action =>
    ACTIONS.some((action) => action === value);

// What an action asks of the session: nothing; a second-factor confirmation (sign-in or step-up)
// in the last 7 days ("recent"); or a step-up in the last 30 minutes ("fresh").
export type StepUpTier = "none" | "recent" | "fresh";

export type ActionPolicy = {
    readonly stepUp: StepUpTier;
    readonly audit: boolean;
};

export const ACTION_POLICY: Readonly<Record<Action, ActionPolicy>> = {
    "accounts:read": { stepUp: "none", audit: false },
    "accounts:create": { stepUp: "recent", audit: true },
    "accounts:suspend": { stepUp: "recent", audit: true },
    "accounts:reinstate": { stepUp: "recent", audit: true },
    "accounts:rename": { stepUp: "recent", audit: true },
    "accounts:recover": { stepUp: "fresh", audit: true },
    "roles:manage": { stepUp: "fresh", audit: true },
    "roles:assign": { stepUp: "recent", audit: true },
    "devices:manage": { stepUp: "recent", audit: true },
    "devices:override-window": { stepUp: "recent", audit: true },
    "entitlements:issue": { stepUp: "recent", audit: true },
    "entitlements:suspend": { stepUp: "recent", audit: true },
    "entitlements:revoke": { stepUp: "recent", audit: true },
    "releases:promote": { stepUp: "recent", audit: true },
    "facts:promote": { stepUp: "recent", audit: true },
    "facts:override": { stepUp: "recent", audit: true },
    "tickets:reply": { stepUp: "none", audit: true },
    "moderation:remove": { stepUp: "none", audit: true },
    "applications:review": { stepUp: "none", audit: true },
    // Working the review queue and reading crash summaries. Its own action so that whoever
    // triages the queue need not hold the power to suspend; what staff then do about an account
    // is a separate, stepped-up action.
    "risk:review": { stepUp: "none", audit: true },
    "audit:read": { stepUp: "none", audit: false },
};
