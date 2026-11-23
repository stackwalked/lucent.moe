import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { ContentId, PostRefusal, ViewRefusal } from "./community.ts";
import { ProfileVisibility } from "./privacy.ts";
import { Done } from "./shared.ts";

export const Bio = z.string().max(500);

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
});
