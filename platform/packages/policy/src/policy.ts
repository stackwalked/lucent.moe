import { type AccountId, type EpochMs, isSeconds, type Seconds } from "@lucent/core/brands";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { ClientInfo } from "@lucent/core/scalars";
import { ACTION_POLICY, type Action } from "./action-list.ts";

const stepUpWindow = 1_800;
invariant(isSeconds(stepUpWindow), "the step-up window is whole seconds");
export const STEP_UP_WINDOW_SECONDS: Seconds = stepUpWindow;
const STEP_UP_WINDOW_MS = STEP_UP_WINDOW_SECONDS * 1_000;

// "recent": the session's last second-factor confirmation (its sign-in, which finishes every
// factor, or a step-up) is at most a week old.
const recentWindow = 7 * 24 * 60 * 60;
invariant(isSeconds(recentWindow), "the recent window is whole seconds");
export const RECENT_WINDOW_SECONDS: Seconds = recentWindow;
const RECENT_WINDOW_MS = RECENT_WINDOW_SECONDS * 1_000;

// What a session knows about its holder, and where the request came from (for audit).
// Everything else about the caller is re-read under lock.
export type Caller = {
    readonly accountId: AccountId;
    readonly stepUpAt: EpochMs | null;
    // When the session's sign-in finished (every factor passed); absent for a caller that has
    // no session, which then never meets "recent".
    readonly authenticatedAt?: EpochMs | null | undefined;
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
    readonly authenticatedAt?: EpochMs | null | undefined;
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
    const tier = ACTION_POLICY[params.action].stepUp;
    const stepUpAt = params.subject.stepUpAt;
    if (tier === "fresh") {
        const fresh = stepUpAt !== null && params.txNow - stepUpAt <= STEP_UP_WINDOW_MS;
        if (!fresh) return err({ code: "STEP_UP_REQUIRED", withinSeconds: STEP_UP_WINDOW_SECONDS });
    }
    if (tier === "recent") {
        const confirmedAt = Math.max(params.subject.authenticatedAt ?? 0, stepUpAt ?? 0);
        const recent = confirmedAt > 0 && params.txNow - confirmedAt <= RECENT_WINDOW_MS;
        if (!recent) return err({ code: "STEP_UP_REQUIRED", withinSeconds: RECENT_WINDOW_SECONDS });
    }
    return ok(undefined);
}
