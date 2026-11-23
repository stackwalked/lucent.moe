import {
    CloudItem,
    CloudProduct,
    CreateItem,
    Import,
    Rename,
    Restore,
    Revoke,
} from "@lucent/rpc/web/cloud";
import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchCloudProducts = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("cloud.products.list", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const fetchItems = createServerFn({ method: "GET" })
    .validator((data: unknown) => CloudProduct.parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("cloud.items.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const createEmptyItem = createServerFn({ method: "POST" })
    .validator((data: unknown) => CreateItem.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.items.create", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const fetchHistory = createServerFn({ method: "GET" })
    .validator((data: unknown) => CloudItem.parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("cloud.items.history", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const renameItem = createServerFn({ method: "POST" })
    .validator((data: unknown) => Rename.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.items.rename", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
export const restoreItem = createServerFn({ method: "POST" })
    .validator((data: unknown) => Restore.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.items.restore", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
export const deleteItem = createServerFn({ method: "POST" })
    .validator((data: unknown) => CloudItem.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.items.delete", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
export const createShare = createServerFn({ method: "POST" })
    .validator((data: unknown) => CloudItem.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.shares.create", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
export const revokeShare = createServerFn({ method: "POST" })
    .validator((data: unknown) => Revoke.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.shares.revoke", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
export const importShare = createServerFn({ method: "POST" })
    .validator((data: unknown) => Import.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.shares.import", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });
