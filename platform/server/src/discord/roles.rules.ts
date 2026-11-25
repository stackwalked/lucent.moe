import { type Ok, ok } from "@lucent/core/result";
import type { RoleCondition } from "@lucent/rpc/discord/rules";

export type RoleRule = { readonly roleId: string; readonly condition: RoleCondition };

// What the service knows of a linked account now. `active`: neither suspended nor locked.
export type LinkedStanding = {
    readonly active: boolean;
    readonly entitledProducts: ReadonlySet<string>;
    readonly siteRoles: ReadonlySet<string>;
};

function meets(condition: RoleCondition, standing: LinkedStanding): boolean {
    switch (condition.kind) {
        case "linked":
            return true;
        case "entitled":
            return standing.entitledProducts.has(condition.productId);
        case "holds_role":
            return standing.siteRoles.has(condition.roleId);
    }
}

// The Discord roles the rules give one user, sorted. An unlinked user (null) and an account out
// of good standing get none: suspension ends everything, Discord included.
export function decideRoles(
    rules: readonly RoleRule[],
    standing: LinkedStanding | null,
): Ok<readonly string[]> {
    if (standing === null || !standing.active) return ok([]);
    const roles = new Set<string>();
    for (const rule of rules) {
        if (meets(rule.condition, standing)) roles.add(rule.roleId);
    }
    return ok([...roles].sort());
}
