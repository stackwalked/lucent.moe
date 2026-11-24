import { err, ok, type Result } from "@lucent/core/result";

export const MAX_SHARES_PER_ITEM = 16;

export function decideShare(params: {
    readonly shares: number;
    readonly maxShares: number;
}): Result<void, { readonly code: "SHARE_LIMIT" }> {
    return params.shares >= params.maxShares ? err({ code: "SHARE_LIMIT" }) : ok(undefined);
}
