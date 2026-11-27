import { ContentId } from "@lucent/rpc/web/community";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const reportContent = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({
                kind: z.enum(["comment", "shout", "profile", "listing"]),
                targetId: ContentId,
                reason: z.enum(["spam", "abuse", "other"]),
                note: z.string().max(500),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("moderation.reports.create", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

// What closes the member's inputs: their active mutes and bars (the account page's own read).
export const fetchStanding = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("privacy.restrictions.list", {});
    return reply.ok ? done(reply.value.restrictions) : refuse(reply.error);
});
