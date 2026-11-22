import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { readPlatform } from "../../../server/platform.ts";

// The reads the routes load. The promotions are in promote.ts, so they ride in the pages' own
// chunks rather than every page's first load.
const ReleaseId = z.string().regex(/^[0-9a-f]{32}$/);

export const listReleases = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("admin.releases.list", {});
    return reply.ok ? done(reply.value.lines) : refuse(reply.error);
});

export const listFactSets = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ releaseId: ReleaseId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.facts.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
