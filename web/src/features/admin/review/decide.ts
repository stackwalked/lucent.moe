import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform } from "../../../server/platform.ts";

export const decideReview = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({
                itemId: z.string().regex(/^[1-9][0-9]{0,18}$/),
                outcome: z.enum(["no_action", "actioned"]),
                note: z.string().max(500).nullable(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.review.decide", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
