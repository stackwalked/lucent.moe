import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import { CREDENTIAL_FRESHNESS_MS } from "../auth/sessions.ts";

// A member deleting their own account. Asking starts a grace period (a hijacked account can't be
// destroyed in one click); the member keeps the account by signing in and saying so, and nothing
// else cancels it: while it waits the account works as before. When the period ends the account is
// stripped to a tombstone (deletion/strip.ts) and stays one.
export const DELETION_GRACE_MS = 7 * 24 * 60 * 60_000;

export type DeletionState =
    | { readonly kind: "none" }
    | { readonly kind: "pending"; readonly dueAt: EpochMs }
    | { readonly kind: "completed" };

export const DELETION_EVENTS = ["request", "cancel", "complete"] as const;
export type DeletionEvent = (typeof DELETION_EVENTS)[number];

// What the account holds at the moment of the event. `lastProofAt` is when the session last proved
// a factor (sign-in or step-up), as auth/sessions.ts's requireFresh reads it.
export type DeletionFacts = {
    readonly isRoot: boolean;
    // Any role held now. Staff are demoted before they can go: a deleted staff account would leave
    // grants and queues pointing at nobody, and nothing here may decide for staff what `can()`
    // would.
    readonly holdsRole: boolean;
    readonly lastProofAt: EpochMs | null;
    readonly now: EpochMs;
};

export type DeletionPlan =
    | { readonly kind: "request"; readonly dueAt: EpochMs }
    // Asked again while one waits: the date stands, nothing is written.
    | { readonly kind: "unchanged"; readonly dueAt: EpochMs | null }
    | { readonly kind: "cancel" }
    | { readonly kind: "complete" };

export type DeletionRefusal =
    | { readonly code: "STAFF_CANNOT_DELETE" }
    | { readonly code: "REAUTH_REQUIRED"; readonly withinSeconds: number }
    | { readonly code: "NOT_DUE" }
    | { readonly code: "NOT_PENDING" }
    | { readonly code: "ACCOUNT_DELETED" };

export function decideDeletion(params: {
    readonly state: DeletionState;
    readonly event: DeletionEvent;
    readonly facts: DeletionFacts;
}): Result<DeletionPlan, DeletionRefusal> {
    const { state, event, facts } = params;
    if (state.kind === "completed") return err({ code: "ACCOUNT_DELETED" });
    if (event === "cancel") {
        return state.kind === "pending"
            ? ok({ kind: "cancel" })
            : ok({ kind: "unchanged", dueAt: null });
    }
    // Checked at completion too: a role granted during the grace period holds the deletion until
    // staff take it away again.
    if (facts.isRoot || facts.holdsRole) return err({ code: "STAFF_CANNOT_DELETE" });
    if (event === "complete") {
        if (state.kind !== "pending") return err({ code: "NOT_PENDING" });
        if (state.dueAt > facts.now) return err({ code: "NOT_DUE" });
        return ok({ kind: "complete" });
    }
    if (state.kind === "pending") return ok({ kind: "unchanged", dueAt: state.dueAt });
    const fresh =
        facts.lastProofAt !== null && facts.now - facts.lastProofAt <= CREDENTIAL_FRESHNESS_MS;
    if (!fresh) {
        return err({ code: "REAUTH_REQUIRED", withinSeconds: CREDENTIAL_FRESHNESS_MS / 1_000 });
    }
    return ok({ kind: "request", dueAt: EpochMs.parse(facts.now + DELETION_GRACE_MS) });
}
