import { z } from "zod";

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
    "audit:read",
] as const;

export const ActionSchema = z.enum(ACTIONS);
export type Action = z.infer<typeof ActionSchema>;

export type ActionPolicy = {
    readonly stepUp: boolean;
    readonly audit: boolean;
};

export const ACTION_POLICY: Readonly<Record<Action, ActionPolicy>> = {
    "accounts:read": { stepUp: false, audit: false },
    "accounts:create": { stepUp: true, audit: true },
    "accounts:suspend": { stepUp: true, audit: true },
    "accounts:reinstate": { stepUp: true, audit: true },
    "accounts:rename": { stepUp: true, audit: true },
    "accounts:recover": { stepUp: true, audit: true },
    "roles:manage": { stepUp: true, audit: true },
    "roles:assign": { stepUp: true, audit: true },
    "devices:manage": { stepUp: true, audit: true },
    "devices:override-window": { stepUp: true, audit: true },
    "entitlements:issue": { stepUp: true, audit: true },
    "entitlements:suspend": { stepUp: true, audit: true },
    "entitlements:revoke": { stepUp: true, audit: true },
    "releases:promote": { stepUp: true, audit: true },
    "facts:promote": { stepUp: true, audit: true },
    "facts:override": { stepUp: true, audit: true },
    "tickets:reply": { stepUp: false, audit: true },
    "moderation:remove": { stepUp: false, audit: true },
    "applications:review": { stepUp: false, audit: true },
    "audit:read": { stepUp: false, audit: false },
};
