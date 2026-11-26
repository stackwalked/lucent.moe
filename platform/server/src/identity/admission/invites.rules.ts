import { err, ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

// Staff grant allowance by hand to a few hundred members; this only bounds a typo.
export const MAX_ALLOWANCE = 1_000;

// A redeem naming an address that has an account answers as if it worked and leaves the invite
// unused, so a holder could otherwise keep asking which addresses have accounts. The third such
// redeem closes the invite for good.
export const MAX_PROBES = 3;

// An invite as its row stands. `redeemedAt` and `revokedAt` never both hold (the table checks it).
// `probes`: redeems so far that named an address with an account.
export type Invite = {
    readonly expiresAt: EpochMs;
    readonly revokedAt: EpochMs | null;
    readonly redeemedAt: EpochMs | null;
    readonly probes: number;
};

export type InviteState = "unused" | "used" | "revoked" | "expired";

// Usable strictly before its expiry, as a reset link is. An invite closed by probing reads as used,
// to its inviter too: a state of its own would tell them which addresses have accounts. Like a
// used one it stays spent, or an inviter could probe without end through new invites.
export function inviteStateAt(invite: Invite, now: EpochMs): InviteState {
    if (invite.redeemedAt !== null || invite.probes >= MAX_PROBES) return "used";
    if (invite.revokedAt !== null) return "revoked";
    if (invite.expiresAt <= now) return "expired";
    return "unused";
}

// Spent: an invite that vouched for someone, or still may. One revoked or left to expire unused
// vouched for nobody and returns to the allowance.
export function spentOf(invites: readonly Invite[], now: EpochMs): number {
    return invites.filter((invite) => {
        const state = inviteStateAt(invite, now);
        return state === "used" || state === "unused";
    }).length;
}

export function decideCreateInvite(params: {
    readonly granted: number;
    readonly spent: number;
    readonly now: EpochMs;
}) {
    if (params.spent >= params.granted) return err({ code: "NO_ALLOWANCE" } as const);
    return ok({ expiresAt: EpochMs.parse(params.now + INVITE_TTL_MS) });
}

// Why an invite cannot be redeemed, for tests and logs; the holder only ever hears INVITE_INVALID.
// An inviter suspended or locked since issuing it vouches for nobody meanwhile: the invite stays
// as it is and works again if they are reinstated before it expires. A usable invite naming an
// address that has an account is a probe: counted, answered like a success, closing the invite
// once it is the last one allowed.
export function decideRedeemInvite(params: {
    readonly invite: Invite | null;
    readonly inviterActive: boolean;
    readonly emailTaken: boolean;
    readonly now: EpochMs;
}) {
    if (params.invite === null) return err({ code: "UNKNOWN" } as const);
    const state = inviteStateAt(params.invite, params.now);
    if (state === "used") return err({ code: "USED" } as const);
    if (state === "revoked") return err({ code: "REVOKED" } as const);
    if (state === "expired") return err({ code: "EXPIRED" } as const);
    if (!params.inviterActive) return err({ code: "INVITER_UNAVAILABLE" } as const);
    if (!params.emailTaken) return ok({ kind: "create" } as const);
    const probes = params.invite.probes + 1;
    return ok({ kind: "probe", probes, closes: probes >= MAX_PROBES } as const);
}

// Revoking one already revoked or expired changes nothing and is not an error: either way it is
// no longer spent.
export function decideRevokeInvite(invite: Invite, now: EpochMs) {
    const state = inviteStateAt(invite, now);
    if (state === "used") return err({ code: "INVITE_USED" } as const);
    return ok({ revoke: state === "unused" });
}

export function decideSetAllowance(params: { readonly granted: number; readonly spent: number }) {
    if (!Number.isInteger(params.granted) || params.granted < 0 || params.granted > MAX_ALLOWANCE)
        return err({ code: "INVALID_ALLOWANCE" } as const);
    if (params.granted < params.spent) return err({ code: "BELOW_SPENT" } as const);
    return ok(undefined);
}
