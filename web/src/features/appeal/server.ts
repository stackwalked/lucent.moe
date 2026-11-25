import { MessageBody } from "@lucent/rpc/web/tickets";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchAppeal = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("appeals.read", {});
    if (!reply.ok) return refuse(reply.error);
    // A suspended account may delete itself; the privacy page's section is shown here.
    const deletion = await readPlatform("appeals.deletion.read", {});
    if (!deletion.ok) return refuse(deletion.error);
    return done({ ...reply.value, deletion: deletion.value });
});

export const sendAppeal = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ body: MessageBody }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("appeals.send", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
