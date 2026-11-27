import { ProductId } from "@lucent/core/scalars";
import { ItemKind } from "@lucent/rpc/cloud-item";
import {
    CloudItem,
    CloudProduct,
    CreateItem,
    Import,
    ListingDescription,
    Rename,
    Restore,
    Revoke,
} from "@lucent/rpc/web/cloud";
import { Cursor } from "@lucent/rpc/web/shared";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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

const ListingId = z.uuid();
const Description = ListingDescription;
const Summary = z
    .string()
    .trim()
    .max(140)
    .regex(/^[^\r\n]*$/);

export const fetchListings = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z
            .strictObject({
                productId: ProductId.optional(),
                owner: z.string().max(64).optional(),
                kind: ItemKind.optional(),
                text: z.string().min(1).max(64).optional(),
                cursor: Cursor.optional(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.listings.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const fetchMine = createServerFn({ method: "GET" })
    .validator((data: unknown) => CloudProduct.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.listings.mine", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const listItem = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        CloudItem.extend({ summary: Summary, description: Description }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.listings.create", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const fetchListing = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ listingId: ListingId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("cloud.listings.get", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const saveListing = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({ listingId: ListingId, summary: Summary, description: Description })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.listings.update", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const unlistItem = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ listingId: ListingId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.listings.remove", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const addListing = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ listingId: ListingId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("cloud.listings.add", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

// What staff published, for the products the member holds and for everyone.
export const fetchStaffFiles = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("resources.list", {});
    return reply.ok ? done(reply.value.items) : refuse(reply.error);
});
