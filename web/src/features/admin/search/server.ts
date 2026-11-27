import { SEARCH_TEXT_MIN } from "@lucent/rpc/web/search-text";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform } from "../../../server/platform.ts";

export const searchStaff = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ text: z.string().trim().min(SEARCH_TEXT_MIN).max(120) }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.search", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
