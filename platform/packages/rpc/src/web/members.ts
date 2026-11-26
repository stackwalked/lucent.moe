import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { AvatarDigest } from "./community.ts";
import { MemberRefusal } from "./inbox.ts";
import { RoleLabelColor } from "./profile.ts";

// The members directory. `sort` defaults to "number" (member number ascending); "newest" is
// joined descending. `text` is a case-insensitive username prefix. `cursor` is the opaque page
// key `next` of the page before. `total` counts every row the viewer could page through with
// the same text: private profiles (except the viewer's own), tombstones, suspended accounts
// and blocks in either direction never appear.
export const membersContract = defineContract({
    "members.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({
            sort: z.enum(["number", "newest"]).optional(),
            text: z.string().min(1).max(64).optional(),
            cursor: z.string().max(200).optional(),
        }),
        output: z.object({
            items: z.array(
                z.object({
                    username: z.string(),
                    avatar: AvatarDigest.nullable(),
                    memberNo: z.number(),
                    joinedAt: EpochMs,
                    tagline: z.string(),
                    role: z.object({ name: z.string(), color: RoleLabelColor }).nullable(),
                }),
            ),
            next: z.string().nullable(),
            total: z.number(),
        }),
        error: MemberRefusal,
    },
});
