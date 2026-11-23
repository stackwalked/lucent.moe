import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform } from "../../../server/platform.ts";

export const setOverride = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({
                releaseId: z.string().regex(/^[0-9a-f]{32}$/),
                kind: z.enum(["feature", "capability"]),
                key: z.string().regex(/^[0-9a-f]{16}$/),
                off: z.boolean(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.overrides.set", data);
        return reply.ok ? done(reply.value.changed) : refuse(reply.error);
    });
