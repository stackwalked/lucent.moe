import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { readPlatform } from "../../../server/platform.ts";

// The read the release route loads. The switch is in switch.ts, so it rides in the page's own
// chunk.
const ReleaseId = z.string().regex(/^[0-9a-f]{32}$/);

export const listOverrides = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ releaseId: ReleaseId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.overrides.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
