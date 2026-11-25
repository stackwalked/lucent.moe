import { err, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";
import { decidePosting, type PostingRefusal, type Restriction } from "./standing.rules.ts";

export type ProfileRemoved = { readonly code: "PROFILE_REMOVED" };

// Setting an avatar is writing on the profile, so a restriction that closes the profile closes
// it too. A profile staff removed takes no new picture until its owner writes a new bio, which is
// what lifts the removal (profiles.ts). Clearing an avatar is not posting and is never refused.
export function decideSetAvatar(params: {
    readonly restrictions: readonly Restriction[];
    readonly profileRemoved: boolean;
    readonly now: EpochMs;
}): Result<null, PostingRefusal | ProfileRemoved> {
    const posting = decidePosting({
        restrictions: params.restrictions,
        surface: "profile",
        productId: null,
        now: params.now,
    });
    if (!posting.ok) return posting;
    if (params.profileRemoved) return err({ code: "PROFILE_REMOVED" });
    return posting;
}
