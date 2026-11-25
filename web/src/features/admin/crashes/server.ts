import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { readPlatform } from "../../../server/platform.ts";
import { readCrashesQuery } from "./filter.ts";

// 50 per page is platform's: the contract has no page size to ask for.
export const listCrashes = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z
            .strictObject({
                q: z.string().max(512).nullable(),
                cursor: z.string().max(512).nullable(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const { filter } = readCrashesQuery(data.q ?? undefined);
        const reply = await readPlatform("admin.crashes.summaries.list", {
            ...filter,
            cursor: data.cursor,
        });
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
