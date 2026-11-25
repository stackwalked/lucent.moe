import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId } from "@lucent/core/scalars";

export type RootTransferParty = {
    readonly id: AccountId;
    readonly status: "active" | "suspended";
    readonly isLocked: boolean;
    readonly hasPasskey: boolean;
};

export type RootTransferRefusal =
    | { readonly code: "NO_ROOT" }
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "ALREADY_ROOT" }
    | { readonly code: "TARGET_SUSPENDED" }
    | { readonly code: "TARGET_LOCKED" }
    | { readonly code: "TARGET_NO_PASSKEY" };

export type RootTransferPlan = { readonly from: AccountId; readonly to: AccountId };

// Root goes to an account that could hold it (account_root_inviolable: active and unlocked) and
// that isn't root already. It must also be able to step up, which is passkey-only
// (auth/credentials.ts beginStepUp): root without a passkey could sign in but never act. Without a root there is nothing to hand over: that is bootstrap's job.
export function decideRootTransfer(params: {
    readonly root: RootTransferParty | null;
    readonly target: RootTransferParty | null;
}): Result<RootTransferPlan, RootTransferRefusal> {
    const { root, target } = params;
    if (root === null) return err({ code: "NO_ROOT" });
    if (target === null) return err({ code: "NOT_FOUND" });
    if (target.id === root.id) return err({ code: "ALREADY_ROOT" });
    if (target.status !== "active") return err({ code: "TARGET_SUSPENDED" });
    if (target.isLocked) return err({ code: "TARGET_LOCKED" });
    if (!target.hasPasskey) return err({ code: "TARGET_NO_PASSKEY" });
    return ok({ from: root.id, to: target.id });
}
