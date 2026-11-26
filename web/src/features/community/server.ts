import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { readPlatform } from "../../server/platform.ts";

export const fetchMembers = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z
            .strictObject({
                sort: z.enum(["number", "newest"]).optional(),
                text: z.string().min(1).max(64).optional(),
                cursor: z.string().max(200).optional(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await readPlatform("members.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
