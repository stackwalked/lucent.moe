import { isRoleId, type RoleId } from "@lucent/core/brands";
import { type AccountStatus, isAccountStatus } from "@lucent/rpc/web/account-status";
import { parseQuery } from "../query.ts";

const KEYS = ["status", "role"] as const;

// The contract's limit on search text: longer text is cut rather than refused.
const TEXT_MAX = 64;

// ?q= as the accounts list's filter. A token whose value isn't a status or a role id is left out
// and said back as ignored.
export function readAccountQuery(q: string | undefined): {
    readonly status: AccountStatus | null;
    readonly roleId: RoleId | null;
    readonly text: string | null;
    readonly ignored: readonly string[];
} {
    const query = parseQuery(q, KEYS);
    const { status, role } = query.tokens;
    const unfit = [
        ...(status !== undefined && !isAccountStatus(status) ? [`status:${status}`] : []),
        ...(role !== undefined && !isRoleId(role) ? [`role:${role}`] : []),
    ];
    return {
        status: isAccountStatus(status) ? status : null,
        roleId: isRoleId(role) ? role : null,
        text: query.text?.slice(0, TEXT_MAX) ?? null,
        ignored: [...query.ignored, ...unfit],
    };
}
