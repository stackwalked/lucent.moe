import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Avatar, ContentId, PostingRestricted, PostRefusal, ViewRefusal } from "./community.ts";
import { MemberRefusal } from "./inbox.ts";
import { ProfileVisibility } from "./privacy.ts";
import { Done, refusal, Unavailable } from "./shared.ts";

export const Bio = z.string().max(500);

// What the avatar upload route (AVATAR_UPLOAD_PATH in web.ts) answers instead of the new digests:
// the posting refusals, a profile staff removed (a new bio lifts that), and what the decoder made
// of the file: more than 512 KiB or 4096 px a side, not a JPEG, PNG or WebP by its bytes, broken,
// or too slow to decode.
export const AvatarUploadRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    PostingRestricted,
    refusal("PROFILE_REMOVED"),
    refusal("IMAGE_TOO_LARGE"),
    refusal("NOT_AN_IMAGE"),
    refusal("IMAGE_UNDECODABLE"),
    refusal("IMAGE_TIMED_OUT"),
]);

export const profileContract = defineContract({
    "profile.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({ username: z.string().max(64) }),
        output: z.object({
            // The profile row's id, which a report names; null before the first bio or setting.
            id: ContentId.nullable(),
            username: z.string(),
            bio: Bio,
            visibility: ProfileVisibility,
            joinedAt: EpochMs,
            isSelf: z.boolean(),
            avatar: Avatar.nullable(),
        }),
        error: ViewRefusal,
    },
    "profile.bio.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({ bio: Bio }),
        output: Done,
        error: PostRefusal,
    },
    // Setting one is the upload route's; taking it down is not posting, so never restricted.
    "profile.avatar.clear": {
        session: "member",
        effect: "write",
        input: z.strictObject({}),
        output: Done,
        error: MemberRefusal,
    },
});
