import { SearchText } from "@lucent/rpc/web/search";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { readPlatform } from "../../server/platform.ts";

export const searchCommunity = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ q: SearchText }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("search.results.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
