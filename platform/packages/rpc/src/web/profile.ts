import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { CommentBody } from "./comments.ts";
import {
    Author,
    Avatar,
    ContentId,
    PostingRestricted,
    PostRefusal,
    ViewRefusal,
} from "./community.ts";
import { MemberRefusal } from "./inbox.ts";
import { ProfileVisibility } from "./privacy.ts";
import { Done, refusal, Unavailable } from "./shared.ts";

export const Bio = z.string().max(500);
// One line beside the name; the column's check holds it to the same shape.
export const Tagline = z
    .string()
    .max(80)
    .regex(/^[^\r\n]*$/);

export const RoleLabelColor = z.enum(["pink", "shu", "ok", "wait", "violet", "aqua"]);

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
            memberNo: z.number().int().positive(),
            tagline: z.string(),
            // One digest in the avatar image store (the banner is a single 1500x400 WebP).
            banner: z.string().nullable(),
            role: z.object({ name: z.string(), color: RoleLabelColor }).nullable(),
            // Each of the five is null when the owner's opt-out hides it from this viewer;
            // the owner always reads their own. `invited` is oldest first, at most 50.
            invitedBy: z.string().nullable(),
            invited: z.array(z.string()).readonly().nullable(),
            products: z.array(z.string()).readonly().nullable(),
            // "now" for a live presence, else the start of the UTC day of the account's last
            // session as EpochMs, else null when never seen.
            lastSeen: z.union([z.literal("now"), EpochMs]).nullable(),
            discord: z.string().nullable(),
            // Whether the viewer may see the wall: the owner always, others unless the owner
            // hid it.
            wall: z.boolean(),
        }),
        error: ViewRefusal,
    },
    // The profile's wall, newest first. Refused as a missing thing on a private profile (the
    // owner's own excepted), a tombstone, and a block either way; an owner who hid the wall
    // shows others an empty page.
    "profile.comments.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ username: z.string().max(64), cursor: ContentId.nullable() }),
        output: z.object({
            items: z
                .array(
                    z.object({
                        id: ContentId,
                        author: Author,
                        body: z.string(),
                        createdAt: EpochMs,
                        canDelete: z.boolean(),
                    }),
                )
                .readonly(),
            nextCursor: ContentId.nullable(),
        }),
        error: ViewRefusal,
    },
    "profile.comments.create": {
        session: "member",
        effect: "write",
        input: z.strictObject({ username: z.string().max(64), body: CommentBody }),
        output: z.object({ id: ContentId }),
        error: PostRefusal,
    },
    // The wall's owner and the comment's author may delete it; anyone else is told it is not
    // there. Staff remove through moderation reports, as for any comment.
    "profile.comments.delete": {
        session: "member",
        effect: "write",
        input: z.strictObject({ id: ContentId }),
        output: Done,
        error: ViewRefusal,
    },
    "profile.bio.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({ bio: Bio }),
        output: Done,
        error: PostRefusal,
    },
    "profile.tagline.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({ tagline: Tagline }),
        output: Done,
        error: PostRefusal,
    },
    // Setting one is the upload route's; taking it down is not posting, so never restricted.
    "profile.banner.clear": {
        session: "member",
        effect: "write",
        input: z.strictObject({}),
        output: Done,
        error: MemberRefusal,
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
