import { err, ok, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";

export function decideRefresh(params: {
    readonly held: {
        readonly jkt: string;
        readonly revoked_at: EpochMs | null;
        readonly expires_at: EpochMs;
        readonly rotated_at: EpochMs | null;
        readonly live_parent: Uint8Array | null;
        readonly has_live: boolean;
    };
    readonly jkt: string;
    readonly txNow: EpochMs;
    readonly graceMs: number;
    readonly tokenHash: Uint8Array;
}): Result<"rotate" | "replace_successor" | "revoke_family", { readonly code: "invalid_grant" }> {
    const { held, jkt, txNow, tokenHash } = params;
    if (held.revoked_at !== null || held.jkt !== jkt || held.expires_at <= txNow) {
        return err({ code: "invalid_grant" });
    }
    if (held.rotated_at === null) return ok("rotate");
    const parent = held.live_parent;
    if (
        txNow - held.rotated_at <= params.graceMs &&
        held.has_live &&
        parent !== null &&
        parent.byteLength === tokenHash.byteLength &&
        parent.every((b, i) => b === tokenHash[i])
    ) {
        return ok("replace_successor");
    }
    return ok("revoke_family");
}
