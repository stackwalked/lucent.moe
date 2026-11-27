import { AccountId, BearerToken, EpochMs, OperationId, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { CloudId, ItemKind } from "../cloud-item.ts";
import { isCloudItemName } from "../cloud-item-guards.ts";
import { defineContract } from "../contract.ts";
import { Author, PostingRestricted } from "./community.ts";
import { Cursor, Done, refusal, StaffRefusals, Unavailable } from "./shared.ts";

const Revision = z.int32().positive();
export const CloudProduct = z.strictObject({ productId: ProductId });
export const CloudItem = CloudProduct.extend({ itemId: CloudId });
const Name = z.string().min(1).refine(isCloudItemName);
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
// Where a copy came from: the listing, and its owner when they still have a name.
const ItemSource = z.object({ listingId: z.uuid(), owner: z.string().nullable() });
const ListingId = z.uuid();
// One line.
export const ListingSummary = z
    .string()
    .trim()
    .max(140)
    .regex(/^[^\r\n]*$/);
// Plain text, line breaks kept, up to 2,000 characters; the page shows it as written.
export const ListingDescription = z
    .string()
    .trim()
    .max(2_000)
    .refine((value) => !value.includes("\0"));
const ListingState = z.enum(["pending", "listed"]);

// One snapshot as staff read it: `content` is null when it is not text staff can read (then
// `size` is all there is), `escaped` when characters that disguise code were made visible.
const ReviewedContent = z.object({
    revision: Revision,
    // The words that go with this snapshot: the ones that will go live, or the ones now live.
    summary: ListingSummary,
    description: ListingDescription,
    content: z.string().nullable(),
    size: z.int().nonnegative(),
    escaped: z.boolean(),
});
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
            // canCreate is false for a product the member holds items in but could not start today.
            products: z
                .array(z.object({ id: ProductId, name: z.string(), canCreate: z.boolean() }))
                .readonly(),
            canAppend: z.boolean(),
        }),
    },
    "cloud.items.list": {
        ...read,
        input: CloudProduct,
        output: z.array(Item.extend({ source: ItemSource.nullable() })).readonly(),
    },
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
    // Listings: a member offers one of their items to everyone who holds the product. Configs
    // and inventories are listed at once; a script waits for staff (`pending`) and an update of
    // a listed script waits too, while its last approved snapshot stays visible.
    // Without `productId` the list spans every product the viewer holds an active entitlement
    // to; with it and no entitlement the answer is NOT_FOUND. Listing is the owner's own act, so
    // a listing names its owner whatever that owner's profile visibility; only blocked, suspended
    // and gone owners are left out. `owner` narrows to one account's listings and does honour a
    // private profile: it is empty when that account is blocked, private or gone. A cursor is
    // opaque; one that is not what a page returned is INVALID_CURSOR.
    "cloud.listings.list": {
        ...read,
        error: z.discriminatedUnion("code", [...read.error.options, refusal("INVALID_CURSOR")]),
        input: z.strictObject({
            productId: ProductId.optional(),
            owner: z.string().max(64).optional(),
            kind: ItemKind.optional(),
            text: z.string().min(1).max(64).optional(),
            cursor: Cursor.optional(),
        }),
        output: z.object({
            items: z
                .array(
                    z.object({
                        id: ListingId,
                        productId: ProductId,
                        name: z.string(),
                        kind: ItemKind,
                        summary: z.string(),
                        owner: Author,
                        updatedAt: EpochMs,
                        // The viewer already holds a copy.
                        added: z.boolean(),
                    }),
                )
                .readonly(),
            nextCursor: Cursor.nullable(),
        }),
    },
    // The viewer's own listings of the product, in any state but removed.
    // One listing's own page: only what is listed (never a waiting snapshot), to a member with an
    // active entitlement to its product (NOT_FOUND otherwise), with the browse's owner filters.
    // `content` is the listed snapshot as text when the site can show it (never bytes that are
    // not text, never above 256 KB), else null; `size` is its bytes either way. `copy` is the
    // item the viewer made from it, when they did.
    "cloud.listings.get": {
        ...read,
        input: z.strictObject({ listingId: ListingId }),
        output: z.object({
            id: ListingId,
            productId: ProductId,
            name: z.string(),
            kind: ItemKind,
            summary: z.string(),
            description: z.string(),
            owner: Author,
            mine: z.boolean(),
            listedAt: EpochMs,
            updatedAt: EpochMs,
            added: z.boolean(),
            copy: z.object({ itemId: CloudId }).nullable(),
            size: z.int().nonnegative(),
            content: z.string().nullable(),
            // The owner's words, shown to the owner only, are waiting for staff (a script's).
            waiting: z.boolean(),
            // Characters that change how a line reads are in `content` as \u{XXXX}.
            escaped: z.boolean(),
        }),
    },
    "cloud.listings.mine": {
        ...read,
        input: CloudProduct,
        output: z
            .array(
                z.object({
                    id: ListingId,
                    itemId: CloudId,
                    name: z.string(),
                    kind: ItemKind,
                    summary: z.string(),
                    state: ListingState,
                    // A newer snapshot waits for staff (a script's update).
                    pending: z.boolean(),
                    updatedAt: EpochMs,
                }),
            )
            .readonly(),
    },
    "cloud.listings.create": {
        ...write,
        error: z.discriminatedUnion("code", [
            ...write.error.options,
            PostingRestricted,
            refusal("ALREADY_LISTED"),
        ]),
        input: CloudItem.extend({
            summary: ListingSummary,
            description: ListingDescription.optional(),
        }),
        output: z.object({ listingId: ListingId }),
    },
    "cloud.listings.update": {
        ...write,
        error: z.discriminatedUnion("code", [...write.error.options, PostingRestricted]),
        input: z.strictObject({
            listingId: ListingId,
            summary: ListingSummary.optional(),
            description: ListingDescription.optional(),
        }),
        output: Done,
    },
    "cloud.listings.remove": {
        ...write,
        input: z.strictObject({ listingId: ListingId }),
        output: Done,
    },
    // Copies the listed snapshot into the viewer's cloud as a share import does: same limits,
    // same refusals. Adding the same listing twice is ALREADY_ADDED.
    "cloud.listings.add": {
        ...append,
        error: z.object({
            code: z.enum([...append.error.shape.code.options, "ALREADY_ADDED"]),
        }),
        input: z.strictObject({ listingId: ListingId }),
        output: z.object({ itemId: CloudId }),
    },
    // Staff with `moderation:remove`: what waits for approval, oldest first; read what waits
    // (the content is the member's own text: show it as text, never run or render it); approve what
    // was read (`pendingVersion`), or STALE_REVISION when the owner changed what waits since; take
    // a listing down.
    "admin.cloud.listings.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ state: z.literal("pending"), cursor: ListingId.nullable() }),
        output: z.object({
            items: z
                .array(
                    z.object({
                        id: ListingId,
                        productId: ProductId,
                        kind: ItemKind,
                        name: z.string(),
                        summary: z.string(),
                        owner: z.object({ accountId: AccountId, username: z.string().nullable() }),
                        // A first listing, not an update of one already visible.
                        first: z.boolean(),
                        // An update of the words alone: the listed snapshot is unchanged.
                        wordsOnly: z.boolean(),
                        updatedAt: EpochMs,
                    }),
                )
                .readonly(),
            nextCursor: ListingId.nullable(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    "admin.cloud.listings.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({ listingId: ListingId }),
        output: z.object({
            id: ListingId,
            productId: ProductId,
            kind: ItemKind,
            name: z.string(),
            // What staff read, sent back to approve it: it changes whenever the owner changes
            // what waits (the snapshot or the words), and approving a stale one is refused.
            pendingVersion: z.int().nonnegative(),
            // What waits for approval: the snapshot and the words that go live with it. For an
            // update of the words alone, the revision is the one already listed.
            pending: ReviewedContent,
            // The one members see now, when what waits is an update of it.
            listed: ReviewedContent.nullable(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },
    "admin.cloud.listings.approve": {
        session: "member",
        effect: "write",
        input: z.strictObject({ listingId: ListingId, pendingVersion: z.int().nonnegative() }),
        output: Done,
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("STALE_REVISION"),
            // Bytes staff cannot read as text are not approved.
            refusal("UNREADABLE_CONTENT"),
        ]),
    },
    "admin.cloud.listings.remove": {
        session: "member",
        effect: "write",
        input: z.strictObject({ listingId: ListingId }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },
});
