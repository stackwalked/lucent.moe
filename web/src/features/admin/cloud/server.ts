import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

export const listPendingListings = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ cursor: z.uuid().nullable() }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.cloud.listings.list", {
            state: "pending",
            ...data,
        });
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const readListing = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ listingId: z.uuid() }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.cloud.listings.get", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

// The revision is the one the reviewer read; platform refuses it if another is waiting now.
export const approveListing = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ listingId: z.uuid(), revision: z.int().positive() }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.cloud.listings.approve", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const removeListing = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ listingId: z.uuid() }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.cloud.listings.remove", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
