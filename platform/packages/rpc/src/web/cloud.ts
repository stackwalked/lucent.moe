import { BearerToken, OperationId, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { CloudId, ItemKind } from "../cloud-item.ts";
import { defineContract } from "../contract.ts";
import { Done, refusal, Unavailable } from "./shared.ts";

const Revision = z.int32().positive();
export const CloudProduct = z.strictObject({ productId: ProductId });
export const CloudItem = CloudProduct.extend({ itemId: CloudId });
const Name = z
    .string()
    .min(1)
    .refine(
        (s) => s.trim().length > 0 && s.isWellFormed() && !s.includes("\0") && [...s].length <= 64,
    );
export const CreateItem = CloudProduct.extend({
    operationId: OperationId,
    name: Name,
    kind: ItemKind,
});
export const Rename = CloudItem.extend({ base: Revision, name: Name });
export const Restore = CloudItem.extend({ base: Revision, revision: Revision });
export const Revoke = CloudProduct.extend({ shareId: CloudId });
export const Import = CloudProduct.extend({ token: BearerToken });
const Item = z.object({
    itemId: CloudId,
    revision: Revision,
    name: z.string(),
    kind: ItemKind,
});
const Change = z.object({ revision: Revision, conflict: z.boolean() });
const read = {
    session: "member",
    effect: "read",
    error: z.discriminatedUnion("code", [
        Unavailable,
        refusal("SESSION_INVALID"),
        refusal("NOT_FOUND"),
    ]),
} as const;
const write = { ...read, effect: "write" } as const;
const append = {
    ...write,
    error: z.object({
        code: z.enum([
            "SERVICE_UNAVAILABLE",
            "SESSION_INVALID",
            "NOT_FOUND",
            "INVALID_BASE",
            "ITEM_LIMIT",
            "VERSION_LIMIT",
            "SIZE_LIMIT",
            "STORAGE_LIMIT",
            "IDEMPOTENCY_CONFLICT",
        ]),
    }),
} as const;

export const cloudContract = defineContract({
    "cloud.products.list": {
        ...read,
        input: z.strictObject({}),
        output: z.object({
            products: z.array(z.object({ id: ProductId, name: z.string() })).readonly(),
            canAppend: z.boolean(),
        }),
    },
    "cloud.items.list": { ...read, input: CloudProduct, output: z.array(Item).readonly() },
    "cloud.items.create": { ...append, input: CreateItem, output: z.object({ itemId: CloudId }) },
    "cloud.items.history": {
        ...read,
        input: CloudItem,
        output: z.object({
            versions: z.array(Item).readonly(),
            shares: z.array(z.object({ shareId: CloudId, revision: Revision })).readonly(),
        }),
    },
    "cloud.items.rename": { ...append, input: Rename, output: Change },
    "cloud.items.restore": { ...append, input: Restore, output: Change },
    "cloud.items.delete": { ...write, input: CloudItem, output: Done },
    "cloud.shares.create": {
        ...write,
        error: z.discriminatedUnion("code", [...write.error.options, refusal("SHARE_LIMIT")]),
        input: CloudItem,
        output: z.object({ shareId: CloudId, token: BearerToken }),
    },
    "cloud.shares.revoke": { ...write, input: Revoke, output: Done },
    "cloud.shares.import": { ...append, input: Import, output: z.object({ itemId: CloudId }) },
});
