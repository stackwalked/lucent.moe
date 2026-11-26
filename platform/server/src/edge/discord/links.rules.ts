import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

// Long enough to switch to Discord and type it, short enough that a code left on a screen goes
// stale. Ten base32 characters are 50 bits: Discord's own rate limits on a bot's commands are far
// below what guessing one inside ten minutes would take.
export const LINK_CODE_TTL_MS = 10 * 60 * 1_000;

export type LinkRefusal = { readonly code: "CODE_INVALID" } | { readonly code: "ALREADY_LINKED" };

export function decideIssueCode(params: {
    readonly txNow: EpochMs;
    readonly linked: boolean;
}): Result<{ readonly expiresAt: EpochMs }, { readonly code: "ALREADY_LINKED" }> {
    if (params.linked) return err({ code: "ALREADY_LINKED" });
    return ok({ expiresAt: EpochMs.parse(params.txNow + LINK_CODE_TTL_MS) });
}

export type GatheredRedeem = {
    readonly txNow: EpochMs;
    // The code's row, null when no account holds it.
    readonly code: { readonly expiresAt: EpochMs; readonly usedAt: EpochMs | null } | null;
    readonly accountActive: boolean;
    // The code's account already has a Discord user, or this Discord user already has an account.
    readonly accountLinked: boolean;
    readonly userLinked: boolean;
};

// Whatever makes the code unusable answers alike, before anything is said about links: someone
// trying codes learns nothing about whose they are or whether that account is suspended.
export function decideRedeem(gathered: GatheredRedeem): Result<"link", LinkRefusal> {
    const { code } = gathered;
    if (code === null || code.usedAt !== null || code.expiresAt <= gathered.txNow) {
        return err({ code: "CODE_INVALID" });
    }
    if (!gathered.accountActive) return err({ code: "CODE_INVALID" });
    if (gathered.accountLinked || gathered.userLinked) return err({ code: "ALREADY_LINKED" });
    return ok("link");
}
