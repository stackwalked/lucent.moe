import { ok, type Result } from "@lucent/core/result";
import type { AccountId } from "@lucent/core/scalars";
import type { Action } from "@lucent/policy/actions";
import type { AccountStanding } from "@lucent/policy/policy";
import { splitPermissions } from "./permissions.ts";

export function decideStanding(params: {
    readonly accountId: AccountId;
    readonly account: {
        readonly status: "active" | "suspended";
        readonly is_locked: boolean;
        readonly is_root: boolean;
        // A tombstone (deletion/strip.ts) acts for nobody, whatever its status says.
        readonly is_deleted: boolean;
    };
    readonly roles: readonly { readonly rank: number; readonly permissions: readonly string[] }[];
}): Result<AccountStanding, never> {
    let maxRank = 0;
    const permissions = new Set<Action>();
    for (const role of params.roles) {
        maxRank = Math.max(maxRank, role.rank);
        for (const permission of splitPermissions(role.permissions).known) {
            permissions.add(permission);
        }
    }
    return ok({
        accountId: params.accountId,
        isRoot: params.account.is_root,
        isActive:
            params.account.status === "active" &&
            !params.account.is_locked &&
            !params.account.is_deleted,
        maxRank,
        permissions,
    });
}
