import { ChangelogFields, ChangelogId } from "@lucent/rpc/web/record";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

export const listRecord = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("admin.record.list", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const addEntry = createServerFn({ method: "POST" })
    .validator((data: unknown) => ChangelogFields.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.changelog.add", data);
        return reply.ok ? done(reply.value.entryId) : refuse(reply.error);
    });

export const updateEntry = createServerFn({ method: "POST" })
    .validator((data: unknown) => ChangelogFields.extend({ entryId: ChangelogId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.changelog.update", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const deleteEntry = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ entryId: ChangelogId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.changelog.delete", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
