import { AccountId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, refusal, StaffRefusals, Unavailable } from "./shared.ts";

// Files staff publish for members, up to 64 MiB each. A resource naming a product lists for
// members entitled to it; one naming none, for every member. The bytes travel over the internal
// listener's streaming routes (RESOURCE_UPLOAD_PATH, RESOURCE_DOWNLOAD_PATH in web.ts), never
// through these procedures. Publishing, editing and removing take releases:promote.

export const ResourceId = z.uuid();
export const ResourceDigest = z.string().regex(/^[0-9a-f]{64}$/);

// What the browser saves the file as: no path, no control characters.
export const ResourceFileName = z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((name) => !/[\p{Cc}/\\]/u.test(name) && name !== "." && name !== "..");

export const ResourceFields = z.strictObject({
    productId: ProductId.nullable(),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000),
    fileName: ResourceFileName,
});

const Resource = z.object({
    id: ResourceId,
    productId: ProductId.nullable(),
    title: z.string(),
    description: z.string(),
    fileName: z.string(),
    size: z.number().int().positive(),
    publishedAt: EpochMs,
    updatedAt: EpochMs,
});

const StaffRefusal = z.discriminatedUnion("code", [
    ...StaffRefusals,
    refusal("NOT_FOUND"),
    refusal("UNKNOWN_PRODUCT"),
]);

export const resourcesContract = defineContract({
    "resources.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ items: z.array(Resource).readonly() }),
        error: z.discriminatedUnion("code", [Unavailable, refusal("SESSION_INVALID")]),
    },
    // Every resource, newest first, at most a fixed number; `truncated` says there were more.
    // `products` is the catalog a resource may name.
    "admin.resources.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            items: z
                .array(
                    Resource.extend({
                        digest: ResourceDigest,
                        publishedBy: z.object({ id: AccountId, username: z.string().nullable() }),
                    }),
                )
                .readonly(),
            truncated: z.boolean(),
            products: z.array(z.object({ id: ProductId, name: z.string() })).readonly(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    // Publishes bytes uploaded first under their digest; NOT_FOUND when nothing was.
    "admin.resources.publish": {
        session: "member",
        effect: "write",
        input: ResourceFields.extend({ digest: ResourceDigest }),
        output: z.object({ resourceId: ResourceId }),
        error: StaffRefusal,
    },
    "admin.resources.update": {
        session: "member",
        effect: "write",
        input: ResourceFields.extend({ resourceId: ResourceId }),
        output: Done,
        error: StaffRefusal,
    },
    "admin.resources.delete": {
        session: "member",
        effect: "write",
        input: z.strictObject({ resourceId: ResourceId }),
        output: Done,
        error: StaffRefusal,
    },
});
