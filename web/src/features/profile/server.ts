import { Bio } from "@lucent/rpc/web/profile";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchProfile = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ username: z.string().max(64) }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("profile.get", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const saveBio = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ bio: Bio }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("profile.bio.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
