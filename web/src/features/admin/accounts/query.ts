import { RoleId } from "@lucent/core/scalars";
import { type AccountStatus, AccountStatus as Status } from "@lucent/rpc/web";
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
    const status = Status.safeParse(query.tokens.status);
    const role = RoleId.safeParse(query.tokens.role);
    const unfit = [
        ...(query.tokens.status !== undefined && !status.success
            ? [`status:${query.tokens.status}`]
            : []),
        ...(query.tokens.role !== undefined && !role.success ? [`role:${query.tokens.role}`] : []),
    ];
    return {
        status: status.success ? status.data : null,
        roleId: role.success ? role.data : null,
        text: query.text?.slice(0, TEXT_MAX) ?? null,
        ignored: [...query.ignored, ...unfit],
    };
}
