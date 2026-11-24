import { ResourceDigest, ResourceFields, ResourceId } from "@lucent/rpc/web/resources";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

export const listStaffResources = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("admin.resources.list", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const publishResource = createServerFn({ method: "POST" })
    .validator((data: unknown) => ResourceFields.extend({ digest: ResourceDigest }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.resources.publish", data);
        return reply.ok ? done(reply.value.resourceId) : refuse(reply.error);
    });

export const updateResource = createServerFn({ method: "POST" })
    .validator((data: unknown) => ResourceFields.extend({ resourceId: ResourceId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.resources.update", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const deleteResource = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ resourceId: ResourceId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.resources.delete", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
