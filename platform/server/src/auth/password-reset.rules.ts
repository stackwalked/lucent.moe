import { err, ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

export const RESET_LINK_TTL_MS = 15 * 60_000;

// Everything a reset decision reads about an account, gathered under its lock. Role expiry is
// reduced to the two facts the rule needs: a grant that never ends, and the latest end of the rest.
export type ResetAccount = {
    readonly email: string;
    readonly status: "active" | "suspended";
    readonly isLocked: boolean;
    readonly isRoot: boolean;
    readonly hasUsername: boolean;
    readonly roleForever: boolean;
    readonly roleLatestExpiry: EpochMs | null;
    readonly hasSecondFactor: boolean;
};

export type ResetLink = { readonly expiresAt: EpochMs };

// A link is usable strictly before its expiry; at the instant it expires it is already gone.
export function decideResetLink(link: ResetLink | null, now: EpochMs) {
    if (link === null || link.expiresAt <= now) return err({ code: "LINK_INVALID" } as const);
    return ok(link);
}

// Staff opt out even with an unrecognized or low-ranked role, as does anyone who could not
// sign in with a second factor afterwards.
function decideResetEligible(account: ResetAccount | null, now: EpochMs) {
    if (account === null) return err({ code: "NO_ACCOUNT" } as const);
    const staff =
        account.roleForever ||
        (account.roleLatestExpiry !== null && account.roleLatestExpiry > now);
    if (
        account.status !== "active" ||
        account.isLocked ||
        account.isRoot ||
        !account.hasUsername ||
        staff ||
        !account.hasSecondFactor
    )
        return err({ code: "INELIGIBLE" } as const);
    return ok(account);
}

// A live link already exists: asking again sends nothing new, so a request cannot be used to
// pile up mail. An expired one is replaced.
export function decideResetRequest(params: {
    readonly account: ResetAccount | null;
    readonly link: ResetLink | null;
    readonly now: EpochMs;
}) {
    const eligible = decideResetEligible(params.account, params.now);
    if (!eligible.ok) return eligible;
    const live = decideResetLink(params.link, params.now);
    if (live.ok) return err({ code: "LINK_LIVE" } as const);
    return ok({
        email: eligible.value.email,
        replaceExpired: params.link !== null,
        expiresAt: EpochMs.parse(params.now + RESET_LINK_TTL_MS),
    });
}

export function decideResetRedeem(params: {
    readonly account: ResetAccount | null;
    readonly link: ResetLink | null;
    readonly now: EpochMs;
}) {
    const eligible = decideResetEligible(params.account, params.now);
    if (!eligible.ok) return err({ code: "RESET_INVALID" } as const);
    const live = decideResetLink(params.link, params.now);
    if (!live.ok) return err({ code: "RESET_INVALID" } as const);
    return ok(undefined);
}
