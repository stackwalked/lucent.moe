import { err, ok, type Result } from "../core/result.ts";
import { type AccountId, type ClientInfo, type EpochMs, Seconds } from "../core/scalars.ts";
import { ACTION_POLICY, type Action } from "./actions.ts";

export const STEP_UP_WINDOW_SECONDS = Seconds.parse(1_800);
const STEP_UP_WINDOW_MS = STEP_UP_WINDOW_SECONDS * 1_000;

// What a session knows about its holder, and where the request came from (for audit).
// Everything else about the caller is re-read under lock.
export type Caller = {
    readonly accountId: AccountId;
    readonly stepUpAt: EpochMs | null;
    readonly client: ClientInfo | null;
};

export type AccountStanding = {
    readonly accountId: AccountId;
    readonly isRoot: boolean;
    readonly isActive: boolean;
    readonly maxRank: number;
    readonly permissions: ReadonlySet<Action>;
};

export type Subject = AccountStanding & {
    readonly stepUpAt: EpochMs | null;
};

export type RankTarget =
    | { readonly kind: "account"; readonly account: AccountStanding }
    | {
          readonly kind: "role";
          readonly rank: number;
          readonly permissions: readonly Action[];
      };

export function can(subject: Subject, action: Action, target?: RankTarget): boolean {
    if (!subject.isActive) {
        return false;
    }
    if (!subject.isRoot && !subject.permissions.has(action)) {
        return false;
    }
    if (target === undefined) {
        return true;
    }
    switch (target.kind) {
        case "account": {
            if (target.account.isRoot) {
                return false;
            }
            // No Action is self-service: acting on yourself would let any holder of roles:assign
            // or entitlements:issue raise their own standing.
            if (target.account.accountId === subject.accountId) {
                return false;
            }
            return subject.isRoot || subject.maxRank > target.account.maxRank;
        }
        case "role": {
            if (subject.isRoot) {
                return true;
            }
            // A role may only carry what its author holds, or authoring one escalates the author.
            return (
                subject.maxRank > target.rank &&
                target.permissions.every((permission) => subject.permissions.has(permission))
            );
        }
    }
}

export type AuthzRefusal =
    | { readonly code: "FORBIDDEN" }
    | { readonly code: "STEP_UP_REQUIRED"; readonly withinSeconds: Seconds };

export function authorize(params: {
    readonly txNow: EpochMs;
    readonly subject: Subject;
    readonly action: Action;
    readonly target?: RankTarget;
}): Result<void, AuthzRefusal> {
    if (!can(params.subject, params.action, params.target)) {
        return err({ code: "FORBIDDEN" });
    }
    const stepUpAt = params.subject.stepUpAt;
    const stepUpFresh = stepUpAt !== null && params.txNow - stepUpAt <= STEP_UP_WINDOW_MS;
    if (ACTION_POLICY[params.action].stepUp && !stepUpFresh) {
        return err({ code: "STEP_UP_REQUIRED", withinSeconds: STEP_UP_WINDOW_SECONDS });
    }
    return ok(undefined);
}
