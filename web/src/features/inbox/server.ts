import { InboxId } from "@lucent/rpc/web/inbox";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchInbox = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ cursor: InboxId.nullable() }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("inbox.entries.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const markInboxRead = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ id: InboxId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("inbox.entries.read", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
